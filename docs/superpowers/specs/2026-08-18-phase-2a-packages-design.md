# Phase 2a — Packages: content-addressed storage and distribution

**Status:** approved design, not yet planned
**Depends on:** Phase 1 (walking skeleton), merged at `c2e2b90`
**Blocks:** 2b (problem management), 2d (Polygon import)

---

## 1. Goal

Make a package a real, content-addressed artifact that can be built, uploaded,
stored, fetched by a judge, and graded against — replacing the Phase 1 stub in
which every grading job resolves to one hardcoded directory.

Success is a second problem. Today the system can grade exactly one, and the
seam that hides that fact is honest but empty:

```ts
// apps/judged/src/main.ts
hashToProblemCode: () => config.problemCode,
```

Nothing above the DMOJ driver knows a problem directory name — that part of the
Phase 1 design holds. There is simply nothing behind the seam.

## 2. Why this slice comes first

The foundation spec's ordering principle is to build the riskiest integration
first, which is why Phase 1 was the judging pipeline rather than CRUD. The same
argument applies within Phase 2: the package format is the contract that problem
management (2b) and Polygon import (2d) both encode against, and neither can be
designed honestly until it exists. Problem management over packages that are
still a fixed label manages nothing gradeable.

## 3. The constraint that shapes everything

**judge-server cannot receive a package.** Verified against the fork at
`a8cff35`:

- Problems live on the judge's local filesystem. `get_supported_problems`
  (`dmoj/judgeenv.py:302-306`) globs `<glob>/init.yml` and takes each problem's
  id from the **basename of its containing directory**.
- The judge watches those directories with `watchdog` (`dmoj/monitor.py`,
  wired at `dmoj/judge.py:634-635`) and pushes a `supported-problems` list to
  the bridge on change. It also sends its problem list in the handshake.
- The protocol has no transfer packet. The bridge only ever sends grading
  requests.

So something must materialize package contents onto each judge's disk before a
submission for that package can be graded there. That "something" is ours to
build, and it is the judge-agent the foundation spec always described.

## 4. Package format

Ours, not DMOJ's. A package is a directory:

```
manifest.json          schema-versioned; everything grading needs
tests/                 input and answer files
checker/               optional checker source, when not a builtin
```

`manifest.json` carries per-language time and memory limits, the test list with
points and batch structure, and the checker specification.

**The judge-agent renders `manifest.json` into `init.yml` at materialization
time.** Every DMOJ-ism stays behind the seam Phase 1 established. Replacing
judge-server later becomes a change in one renderer rather than a change
everywhere, which is the whole reason the wrapper exists.

This also fixes an inherited inconsistency. Phase 1's `init.yml` was written by
hand with limits omitted, because DMOJ takes time and memory from the
submission packet rather than from `init.yml` (`dmoj/problem.py:62-65`). The
manifest is where limits genuinely live; the renderer decides what DMOJ needs
to be told and how.

## 5. Content addressing

The package hash is `sha256` over a **canonical manifest of file digests** —
each file as `(path, size, sha256)`, sorted by path — not over archive bytes.

Archive bytes vary with tar implementation, mtimes, ordering and compression
level, so hashing them would make identical content produce different hashes on
different machines. Hashing a sorted digest list is deterministic across
tooling, and leaves room for partial or resumable fetch later without changing
the identity of anything.

**The payoff is that a mapping disappears.** judge-server derives a problem's id
from its directory basename, so materializing packages at `/problems/<hash>/`
makes the judge's problem id *be* the package hash. `hashToProblemCode`
collapses to identity, and the driver's `problem-id` field carries a hash. The
judge grades a package, not a problem — which is the honest model, because a
package is immutable and a problem is not.

Immutability also makes the on-disk cache trivially correct: presence is a
directory existence check, and eviction is LRU over directories with no
invalidation logic at all.

## 6. Storage

A content-addressed store on the API host, behind a `PackageStore` interface
with `put`, `get`, `has` and `delete`. Filesystem-backed for now; S3 or MinIO
becomes a swap behind the interface rather than a change at every call site.

Postgres large objects are rejected: packages are bulk binary data with no
transactional relationship to the rows that reference them, and putting them in
the database makes backup, restore and replication worse for no gain.

## 7. Distribution — the judge-agent

New in this slice. The agent runs alongside judge-server inside the judge
container and exposes a small HTTP API on the Compose network:

```
POST /packages/ensure  { hash }  →  200 once materialized, 4xx/5xx otherwise
```

On a miss it fetches the package from the API's internal endpoint, unpacks it
to `/problems/<hash>/`, and returns. `watchdog` notices the new directory and
judge-server re-announces its problem list unprompted.

`judged` calls `ensure` before dispatching, and only sends `submission-request`
once it returns successfully. A judge that cannot obtain a package fails the
job loudly rather than reporting a mystery internal error — which is what
Phase 1 would have done, and what made the fixture-path defect (R26) expensive
to diagnose.

**Direction of travel:** the judge still dials out to `judged`'s bridge, and
`judged` now also dials in to the agent. Both stay on the Compose network, and
neither port is published to the host.

## 8. Judge identity and authentication

Phase 1 shipped with `BridgeServer` replying `handshake-success`
unconditionally, never verifying the judge key (ledger R42). The `key` in
`judge.yml` is decorative, and network isolation is the only control. That was
an accepted deferral when the bridge was the only surface; package fetch adds a
second one, and inventing a separate credential for it would be indefensible
when the schema already has what is needed:

```ts
judgeNodes: { id, name, tokenHash, driver, capabilities, lastSeen }
// unique on name, unique on token_hash
```

Designed in Phase 0, never used. This slice uses it.

One credential per judge: the bridge verifies it at handshake and rejects
unknown or mismatched judges; the package endpoint requires the same
credential. `lastSeen` gets written on handshake and heartbeat, which also gives
the operator a way to answer "is my judge alive" that is not "read the logs".

This closes the hole where anything able to reach port 9999 could register as a
judge and be handed submission source.

## 9. `supported-problems` stops being discarded

`apps/judged/src/drivers/dmoj/dmoj-driver.ts:122` currently drops the packet
outright. Harmless with one hardcoded problem; wrong the moment dispatch can
target a judge that lacks a package.

The driver records the announced set per connection, from both the handshake
and subsequent `supported-problems` packets. This slice does not schedule on it
— concurrency is still 1 — but the data must exist before Phase 4 can, and
recording it now means the agent's `ensure` can be verified against what the
judge actually believes it has, rather than trusted.

## 10. Data model

New:

- `packages` — hash (primary key), size, file count, created_at, uploaded_by.
  The hash is the identity; there is no surrogate key.
- `package_files` — hash, path, size, file_sha256. Enables integrity
  verification and, later, partial fetch.

Changed:

- `problem_revisions.package_hash` becomes a real foreign key to `packages`,
  rather than the free-text label Phase 1 left it as.

Migrations are forward-only and generated by drizzle-kit, per the standing
constraint. The Phase 1 fixture is migrated by building it into a real package
(§12) rather than by editing rows.

**Ordering matters and is easy to get wrong.** `problem_revisions` already holds
a row whose `package_hash` is the literal string `phase1-aplusb`, which
satisfies no foreign key. Adding the constraint while that row exists fails the
migration. The sequence is: create `packages` and `package_files`, build and
register the real `aplusb` package, repoint the existing revision at its hash,
*then* add the foreign key. A plan that generates one migration for all of this
will not apply against an existing database.

## 11. API surface

All under the existing Zod-contract → OpenAPI → generated SDK pipeline; no
hand-written DTOs.

- `POST /packages` — upload, returns the computed hash. Rejects a package whose
  declared manifest does not match its contents.
- `GET /packages/{hash}` — metadata.
- `GET /internal/packages/{hash}/archive` — the bytes, judge credential
  required. Separated from the public surface deliberately: it is machine-to-
  machine, it is not part of the SDK, and it should never be reachable with a
  user session.

Errors stay RFC 9457 with stable codes, per the global constraints.

## 12. Package build tooling

A `package build <dir>` script that turns a directory into a package: computes
file digests, derives the hash, writes the manifest, produces the archive.

Easy to forget and load-bearing — without it nothing can be uploaded, so
nothing in this slice is testable end to end. It also gives the migration path
for the existing fixture: `problems/aplusb/` becomes the first real package,
and the Phase 1 end-to-end script should keep passing against it unchanged.
That is the strongest available regression test for this slice, because it
re-runs the whole judging pipeline against a package that arrived by the new
route.

## 13. Testing

Unit-testable without containers: hash canonicalisation, manifest validation,
manifest → `init.yml` rendering, `PackageStore` against a temp directory.

Requires containers: upload → store → fetch → materialize → grade, which is the
only test that proves the slice works. It belongs in the end-to-end script
rather than the unit suite, for the reason Phase 1 established the hard way —
the Caddy `/ws` defect passed 168 unit tests because every one of them bypassed
the component that was broken.

Two properties deserve explicit tests because they are the ones that will
silently rot:

- The same directory built on two machines produces the same hash. This is the
  whole basis of content addressing and nothing else checks it.
- A package whose file contents do not match its manifest digests is rejected
  at upload. Otherwise the store's integrity claim is decorative.

## 14. Out of scope

Problem CRUD, revisions lifecycle and UI (2b). Statements and Typst rendering
(2c). Polygon import (2d). The missing `CE` verdict — that belongs with
submission modelling, not packages. Multi-judge scheduling, priority and
attempt caps remain deferred to Phase 4.

## 15. Risks

**The agent is a new failure surface between `judged` and grading.** Phase 1's
review found that a wedged component with no timeout stops the queue silently.
`ensure` needs a bounded timeout and a loud failure, and the worker's existing
watchdog must still cover a job whose agent call succeeds but whose grading
never starts.

**Cache growth is unbounded without eviction.** LRU over directories is simple,
but "simple" was also true of the compose-up script that wedged. The eviction
path needs a test, not just a comment.

**Hash canonicalisation is a one-way door.** Changing the algorithm later
invalidates every stored package and every `problem_revisions` row pointing at
one. It is worth getting the canonical form right now, and worth writing down
why it is what it is — which §5 does.

## 16. Resolved decisions

The three questions this spec opened are now closed. Each is recorded with what
it costs if wrong, so a later phase can reverse it knowingly.

**Archive format: `tar` + zstd, using Node's built-in `zlib`.** Verified on this
project's Node 22.22.1: `zlib.zstdCompressSync` exists and round-trips. That was
the deciding fact — the assumption had been that zstd meant a native dependency
and therefore a build burden in the judge and API images, which would have made
gzip the pragmatic choice. It does not, so we get the better ratio for free and
add nothing to either Dockerfile. Cost if wrong: re-compressing stored packages,
which is mechanical because the hash covers file contents rather than archive
bytes (§5) — package identity is unaffected by a change of compressor.

**Maximum package size: 256 MB, no resumable upload.** At this project's stated
scale — one operator, up to a thousand users, one to three VPS — resumable
upload is machinery with no user behind it. Cost if wrong: a setter with a
genuinely large test set gets a hard failure at upload rather than a slow
success, which is at least loud.

**The agent stays purely on-demand.** Pre-warming needs to know what is queued,
which is a scheduling dependency, and scheduling is deferred to Phase 4. The
cost is latency on a cache miss — one fetch and unpack before the first
submission for a package grades. Worth measuring during the end-to-end run so
Phase 4 inherits a number rather than an intuition.

## 17. Remaining unknowns

Deliberately not decided here, because deciding them without evidence would be
guessing:

1. The cache eviction threshold. LRU over directories is the mechanism (§7);
   the size at which it triggers should follow a measurement of real package
   sizes, not precede it.
2. Whether `package_files` earns its keep in this slice. It is specified for
   integrity verification and future partial fetch (§10), and integrity is
   used at upload — but if partial fetch never arrives, a manifest inside the
   package would have been enough. Worth revisiting at the end of the slice.

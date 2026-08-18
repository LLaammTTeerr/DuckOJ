# Phase 2a decision ledger — packages

**What this is.** The running record of every decision made while implementing
Phase 2a, written as the work happened rather than reconstructed afterwards.
The runbook records the user-facing symptoms and how to operate the system;
this records *why* — including why several things were found, judged, and
deliberately left for Phase 2b.

**Read this before Phase 2b.** The table below is the deferred-work summary;
each row's ruling has the full reasoning inline further down.

| Deferred | Ruling |
|---|---|
| Dockerfile COPY manifests are hand-maintained per workspace package, and a missing entry has now broken a real image build twice across two phases | T13-A; `docs/runbook.md`'s "Known issues carried into Phase 2b" |
| The `migrate`/`api` image is a `COPY . .` snapshot — editing a script and re-running against a stale image silently re-runs the *old* script, no error | T14-A |
| `packages/contracts/src/registry.ts:9` hardcodes `/api/v1` as the OpenAPI `servers` URL, outside `@qhhoj/api-prefix`'s single-sourced `API_PREFIX` | Task 13 minor (deferred) |
| `apps/judged`'s suite has flaked three times across two phases (`worker.spec.ts`, `job-store.spec.ts`, `dmoj-driver.spec.ts`), always under full-workspace `pnpm -r test` parallelism, always green in isolation, always on a diff touching nothing in `apps/judged` | Task 6 watch item, Task 14 flake watch, Task 15 D3 — **unreproduced and unexplained**, not fixed |
| A compile error is reported as verdict `IE`, not `CE` (`case_verdict` has no `CE` member) | Carried unchanged from Phase 1 |
| No scheduling policy, priority, or attempt cap — a job that keeps failing to dispatch keeps re-leasing forever | Carried unchanged from Phase 1 |
| Task 9: a narrow `sizeBytes` drift if a first upload's store write succeeds but its transaction fails, and a later re-upload skips the write but records the new length | Task 9 minor (deferred) |
| Task 10: `Materializer.ensure()`'s in-flight-request coalescing is correct (reviewer-verified by experiment: 3 concurrent calls → 1 fetch) but unpinned by the shipped test suite, which only calls it sequentially | Task 10 minor (deferred) |
| Task 13: `judge/entrypoint.sh` waits once for the agent's `/healthz` at startup and never restarts it if it dies later; the container's healthcheck will eventually mark it unhealthy but `restart: unless-stopped` does not act on health alone | Task 13 minor (deferred) |

**A note on how to read it.** Three separate integration bugs this phase were
invisible to a fully green, growing test suite and surfaced only by actually
building an image or bringing the stack up: the Dockerfile COPY manifest
(Task 13, latent since Task 9), the archive-fetch URL missing the API prefix
(Task 13, "the third time this phase a green suite has coexisted with a
broken integration" — after Phase 1's Caddy `/ws` route), and the stale-image
silent-reseed (Task 14). None of the three had, or could have had, a unit
test protecting against it structurally — they are properties of a real build
or a real running container, not of any function's return value. Where a
mutation or reproduction is described below, it happened against the real
artifact (a built image, a live container, a live judge connection), not
against a mock.

Format: `Ruling TNN-X: <decision> — <why> — <what it costs if wrong>`, prefixed
by task number. Entries below this line are the plan's live progress record,
carried forward verbatim from `.superpowers/sdd/2026-08-18-phase-2a-packages/progress.md`
(gitignored, not committed) plus a final Task 15 entry appended for this
acceptance step.

---

# SDD ledger — plan: docs/superpowers/plans/2026-08-18-phase-2a-packages.md

Spec: docs/superpowers/specs/2026-08-18-phase-2a-packages-design.md (reachable — rulings binding)
Worktree: .claude/worktrees/phase-2a-packages on branch worktree-phase-2a-packages, branched from 9cdb4b0.
Baseline entering the plan: 181 tests, all gates green, Phase 1 merged to main at c2e2b90 plus b6b68f4 (test build ordering).

## Pre-flight scan

Cross-task rows — every pair sharing a file or an interface:

| Tasks | Produced → consumed | Result |
|---|---|---|
| 1 → 4, 5, 9, 10 | `parseManifest`, `PackageManifestDto` | ✅ names and types agree |
| 2 → 3 | `PackageFile`, `hashFile` | ✅ T2 declares it consumes nothing from T1; independent, correct |
| 3 → 5, 9, 10 | `packDirectory`, `unpackArchive` | ✅ |
| 4 → 10 | `renderInitYml` | ✅ |
| 6 → 9, 12 | `packages`, `packageFiles` tables | ✅ T6 explicitly forbids the FK; T12 adds it after the data moves |
| 7 → 9 | `PackageStore`, `PACKAGE_STORE` | ✅ |
| 8 → 9 | `JudgeGuard` | ✅ |
| 8 ↔ 11 | both modify `bridge-server.ts` (`verifyJudge`, then `problemsFor`) | ✅ sequential, disjoint additions |
| 10 → 11 | agent `POST /packages/ensure` | ✅ |
| 11 → 13 | `AGENT_ORIGIN` config | ✅ |
| 5 ↔ 13 | `problems/aplusb/init.yml` — T5 forbids deleting, T13 deletes | ✅ deliberate and consistent |
| 7 ↔ 13 | `PACKAGE_STORE_DIR` setting, then its volume | ✅ |
| **5 ↔ 12** | **both build-and-register a package** | ❌ **P2 — see ruling** |

Self-consistency rows — each task's tests against its own code, its files against later touches:

| Task | Check | Result |
|---|---|---|
| 1 | 5 `it` blocks vs "PASS (5 tests)" | ✅ |
| 2 | 7 blocks, cumulative 12 | ✅ |
| 3 | 4 blocks, cumulative 16 | ✅ |
| 4 | 5 blocks, cumulative 21 | ✅ |
| 5 | no unit test; Step 4's reproducibility run is the test cycle | ✅ acceptable — the property it proves is the one that matters |
| 5 | expected file count | ❌ **P1 — see ruling** |
| 6 | 4 tests, cumulative db 12 (8 existing + 4) | ✅ |
| 7 | 6 tests, cumulative api 94 (88 existing + 6) | ✅ correct at that point in the sequence |
| 8-11 | tests given as property + assertion, not full bodies | ⚠️ disclosed in the plan itself; not a hidden defect |
| 12 | no unit test; the two real-database runs plus the upgrade-path simulation are the cycle | ✅ |
| 13, 14, 15 | integration, end-to-end and acceptance respectively | ✅ |

Ruling P1: Task 5 claimed the built fixture would contain 7 files. Verified against the tree — `problems/aplusb` holds exactly 7 files today (`init.yml` plus six test files), so adding `manifest.json` yields **8**. The plan hedged ("confirm against what is on disk"), which would have saved the implementer, but a wrong number in a brief is how an implementer spends time reconciling a discrepancy that was never real. Corrected to 8 with the arithmetic shown. Cost if wrong: an implementer counts and reports 8 against a stated 8.
Ruling P2: Tasks 5 and 12 would each have hand-rolled build-and-register. The review rubric treats duplicated logic as a defect, and this instance is worse than cosmetic — two copies of a hash computation diverging silently means the seed registers one hash while the CLI prints another, and the symptom surfaces on a judge two tasks later with no obvious link. Ruled: extract `scripts/lib/build-package.ts` returning `{ hash, files, archive }`, called by both. Cost if wrong: one extra small module, which is the direction to err in.
Both fixed in the plan before Task 1 (commit 2572d2b).

Task 1: implementer DONE (commit ccbefab). 186/186, all gates green — matches the plan's expected count exactly. Review dispatched (sonnet), pointed specifically at the path-containment validation, since those paths are joined against a directory and written to disk by Task 10's agent: an unchecked path there is an arbitrary-write primitive reachable by anyone who can upload a package.
Task 1 review: spec ✅ compliant, quality Approved. 0 Critical, 0 Important, 2 Minor. Reviewer verified by mutation rather than reading — removed `tests.min(1)`, weakened `schemaVersion` to `z.number()`, and removed the leading-`/` refine in turn, confirming the intended test failed each time and no other test was affected. Files confirmed byte-identical to the brief; 186 total, per-package tallies summed rather than trusted.
Task 1: minor (deferred): the path validation rejects a leading `/` and a `..` component anywhere — including embedded (`foo/../../etc/passwd`) and trailing, which is stronger than a naive prefix check — but accepts Windows separators, URL-encoded traversal (`%2e%2e%2f`), empty segments and a bare `.`. The reviewer traced each through the actual consumer and none is exploitable on POSIX: a backslash is a literal filename character, `%2e` is never decoded by `fs`/`path.join`, `foo//bar` normalises inside the root, and `.` resolves to the root itself where a write fails `EISDIR`. Residual risk only if a judge-agent ever runs on Windows or something upstream URL-decodes. Also note Task 3 guards archive entries separately, so this schema is not the only barrier.
Task 1: minor (deferred): two tests assert on message content with `/input/` and `/tests/`, which zod v4's generic wording could satisfy for an unrelated error. The reviewer confirmed they discriminate for these exact fixtures — the broken-implementation failure mode is "does not throw at all" — but they would be brittle if fixtures or zod's wording drifted.
Task 1: complete (commits 2572d2b..ccbefab, review clean).

Task 2: implementer DONE (commit 45cce2d). 193/193, all gates green — matches the plan's expected count. Review dispatched (sonnet) with an unusually sharp brief for a small diff, because this task is a **one-way door**: the canonical form defines package identity, so changing it later invalidates every stored package and every `problem_revisions` row pointing at one. Asked the reviewer to attempt an actual collision rather than accept the NUL-separator rationale, to check sort stability across case and Unicode normalisation, and to give its own view on whether the duplicate-path check should be case-insensitive given the consumer writes to a filesystem that may be — explicitly without treating the brief's choice as correct by default.
Task 2 review: spec ✅ compliant (byte-identical to the brief, no manifest import, no dependency change), quality Approved with findings. 0 Critical, 2 Important, both about hardening a permanent primitive rather than anything currently broken.
Ruling T2-A (review finding 1): the injectivity the NUL separator buys holds only inside an **unenforced precondition**. The reviewer constructed genuine collisions — e.g. `[{path:'bar',size:2,sha256:'bbb'},{path:'foo',size:1,sha256:'aaa'}]` against `[{path:'bar\0 2\0 bbb\nfoo',size:1,sha256:'aaa'}]` — but both require a NUL byte inside `path` or a non-hex `sha256`, neither of which any real filesystem or `hashFile` output can produce. So the design claim is correct for the data the system will actually feed it, and `canonicalForm` simply does not defend that boundary itself. Fixing: reject `\0` in `path` and validate `sha256` against `/^[0-9a-f]{64}$/`. **Identity-preserving** — it only rejects inputs no real package could have produced, so nothing already hashed changes. Cost if wrong: two cheap guards on a hot path that runs once per package.
Ruling T2-B (review finding 2, and I should have specified this in the plan): **the tests do not pin the canonical byte format.** The reviewer mutation-tested it — swapping the field separator from `\0` to `|`, and separately dropping `size` from the record, each leave all 7 tests green, because every test asserts a *relational* property (order-independence, "changes when X changes") that survives a format change applied consistently. That is precisely the regression class that matters most here: package identity is a permanent commitment, and a future cleanup changing the separator would pass this suite while invalidating every stored hash. Fixing with a golden-vector test — a hardcoded file list and a hardcoded expected digest, computed from the current implementation and pinned. Cost if wrong: one test that must be updated deliberately if the format ever changes, which is exactly the friction wanted.
Task 2 carried finding (for Tasks 9 and 10, not this task): case-insensitive and Unicode-normalisation path collisions. The reviewer's view, which I accept: `packageHash` should **not** case-fold — `README.md` and `readme.md` are legitimately distinct for content identity. The hazard is downstream, where a judge materialises both onto a case-insensitive filesystem (default macOS/Windows), the second write clobbers the first, and a re-hash of the materialised directory diverges from the stored hash. Same class for NFC vs NFD (`café.txt`), which HFS+/APFS auto-normalise. That validation belongs in package upload (Task 9) or the materialiser (Task 10), and adding it later only ever rejects packages — it never changes an existing hash — so it is correctly out of scope here.
Task 2 fix round 1: implementer DONE (commit 893207a). Both guards added with field-naming errors, golden-vector test pinned, 196/196 (186 + 10). Reports identity-preservation confirmed and that changing `\0` to `|` fails the golden test while the other 14 pass. Scoped re-review dispatched (haiku) with three things it must reproduce rather than accept: the two collision constructions actually throwing, the identity-preservation claim checked by hashing a normal fixture against `git show 45cce2d:...hash.ts`, and the golden vector's expected digest being a hardcoded literal rather than a value the test computes by calling the code under test — which would restore precisely the blind spot the fix exists to close.
Task 2 fix round 1 re-review: both findings ADDRESSED, no new defects, no scope creep. Reviewer reproduced rather than accepted: both collision constructions now throw with field-naming errors; the golden vector's expectation is a hardcoded literal, not a value the test computes; and mutating the separator `\0` → `|` failed **only** the golden test (with the new digest recorded) while the other 14 stayed green, then restored clean. Identity preservation confirmed against the pre-fix implementation.
Task 2 note — the re-review contradicted itself on the total, saying "167 tests passing" in one place and 196 in another, with 196 taken from the implementer's report rather than observed. I ran `pnpm -r test` myself and summed the per-package figures: 4+18+4+1+2+15+8+15+41+88 = **196**. The report was right and the reviewer's own figure was wrong. Recording because the correct move when two numbers disagree is to generate a third rather than pick.
Task 2: complete (commits ccbefab..893207a, review clean after 1 fix round).

Task 3: implementer DONE (commit 7744a11). 200/200 (196 + 4), typecheck and lint green across all 10 projects.
Ruling T3-A — **a real defect in my brief's code, found and fixed by the implementer.** The brief wrote `await extract({...}).end(tarBytes)`, which does not wait for anything: `extract()` without a `file` option returns the raw `Unpack` stream rather than a promise, and `.end()` returns `this`, so awaiting it resolves immediately. The round-trip test failed with ENOENT on first run because the read raced still-pending fs writes. Fixed by wrapping in a Promise that resolves on the stream's `'end'` event — which fires only once all pending fs operations settle — and rejects on `'error'`, while still catching the traversal guard's synchronous throw inside `.end()`. Accepted as written: this is the correct shape, and the failure mode it removes (a racy unpack) would have been intermittent and blamed on the filesystem.
Task 3 disclosures accepted: `tar@7.5.22` installed **without** `@types/tar`, because tar 7.x ships its own declarations and the DefinitelyTyped package would conflict — exactly the deviation the dispatch anticipated. The traversal guard fired where the brief predicted, at tar's header-parse stage before any fs write, so no `tar.list` pre-scan fallback was needed; the implementer additionally verified out-of-band that the destination stays empty and nothing escapes anywhere on disk.
Task 3 review: spec ✅ compliant, quality **Approved**. 0 Critical, 0 Important, 1 Minor (an observation, not a defect). All three declared deviations verified on their merits rather than accepted.
Task 3 — the `.end()` bug diagnosis independently reproduced: the reviewer reverted `unpackArchive` to my brief's literal code and got the exact `ENOENT` failure, then stress-tested with **500 files** where nearly every read failed under the buggy version and all passed under the fix across repeated runs. So the fix genuinely awaits tar's completion signal rather than winning a race by timing, which was the specific thing I asked it to rule out.
Task 3 — types verified load-bearing rather than assumed: it injected a bogus option key into `create()` and confirmed `tsc -b` failed with TS2769, proving tar 7's own declarations are actually resolving and not silently degrading to `any`. `@types/tar` confirmed absent from package.json, lockfile and node_modules.
Task 3 — security probes beyond the shipped test, all blocked with the destination left empty: an **absolute-path** entry (built two ways) rejected by the custom filter; a **symlink pointing outside** rejected both for an absolute target (via `strict: true` escalating tar's linkpath warning) and a relative `../` target (tar's own `linkpath escapes extraction directory`). It further confirmed that tar 7.5.22 refuses to write *through* an outward symlink even with no guard code at all — defence in depth underneath ours.
Task 3 — `packDirectory` digest correctness checked against the failure mode that only shows on binary data: a file of invalid UTF-8 hashed to the raw-bytes digest and differed from the decode-then-hash value, which the reviewer computed explicitly to compare. Determinism confirmed byte-for-byte across two packs.
Task 3: minor (deferred): the hostile-archive test's `../escaped` shape is partly redundant with tar's own `strict` mode, which rejects `..` paths with `TAR_ENTRY_ERROR: path contains '..'`. The test still discriminates — that message does not match its `/refus|escape|traver/i` assertion, so a "drop the filter, keep strict" implementation would fail it — and the reviewer confirmed our filter's own message is what actually fires. Recorded for whoever extends the suite.
Task 3: complete (commits 893207a..7744a11, review clean).

Task 4 review: spec ✅ compliant, quality Approved with findings. 0 Critical, 0 Important, 3 Minor. Reviewer confirmed all three "looks wrong but is not" details against the judge-server source directly rather than taking them from my dispatch — `archive: null` against problem.py:213's truthiness guard, limits-from-packet against `Problem.__init__` at problem.py:64, and path fidelity against problem.py:271's `os.path.join`.
Task 4 deviation 1 adjudicated: the claim that strict TypeScript "required imperative loops" is **overstated but not false**. The reviewer reproduced my brief's literal `flatMap`/ternary and it genuinely fails TS2322, because `flatMap`'s inferred `U` cannot unify the two branch shapes — so *some* change was needed. But adding a single return-type annotation to the functional form typechecks clean, so the rewrite to loops was stylistic. Behaviour verified identical across group 0, non-zero groups, mixed manifests, and groups supplied out of order. Accepted as written; the rationale is corrected here rather than in code.
Task 4 deviation 2 adjudicated: the "esbuild parsing issue" reason is **false**, as I established before dispatching — `hash.spec.ts:12` ships the same curly apostrophe and passes. The reviewer independently disproved it a second way: an em dash two lines from the changed line survives untouched and compiles. It scanned the whole diff for other ASCII-isations and found none, so no second wrong-fix rode along.
Task 4 — the pattern I was hunting **did exist**, attached to the other deviation. Intermediate commit c395921 worked the flatMap type error around with `Array<Record<string, any>>` and `doc: any`, commented "to work around strict type checking". It was fully cleaned up in c36d416, and the reviewer confirmed that cleanup was forced rather than cosmetic: `@typescript-eslint/no-explicit-any` is an error in the shared config, so the `any` version would have failed `pnpm lint`. Resolved history, not a live finding — but it is a good illustration that a false rationale in a report usually has a real one nearby.
Ruling T4-A (Minor finding 3, a defect in **my brief**): the shipped batching test asserts only `test_cases.length === 1` and `toHaveProperty('batched')`. It never checks the summed `points` or the batch's contents, so a renderer taking `tests[0].points` instead of summing, or dropping a case from the batch, passes it unchanged. That is grading arithmetic — a wrong batch total is a wrong score — and it is the same can't-fail class as Task 2's missing golden vector. The reviewer confirmed by probe that the runtime behaviour is correct, so this is a coverage gap rather than a live bug, but the coverage is what stops it becoming one. Fixing.
Task 4 fix round 1 re-review: ADDRESSED, no new defects, no scope creep. The fixture defeats the indistinguishability trap — points are 2 and 3, sum 5, and no individual case equals 5, so the assertion genuinely separates summing from taking-the-first. Both mutations reproduced independently (`expected 2 to be 5`; `expected [...] to have a length of 2 but got 1`), the mixed-group test asserts both halves in one document, and `init-yml.ts` is untouched by the round. Both report corrections landed — the TypeScript rationale corrected explicitly, the false esbuild claim by removal.
Task 4: complete (commits 7744a11..e62bc14, review clean after 1 fix round). 206 tests.

Ruling W1 (repo hygiene, not a review finding): two per-task report files under `.superpowers/` were **tracked and committed** (task-4 in e62bc14, task-5 in 2adb159). The ignore rule is intact — `git check-ignore` confirms `progress.md` is correctly ignored by `.gitignore:10` — so these must have been force-added, and once a path is tracked the ignore rule stops applying to it. That is SDD workspace scratch leaking into branch history and eventually into main; Phase 1 deliberately kept every report untracked. Untracked with `git rm --cached` (files remain on disk for the review loop, 17 still present). Fixed in the controller session rather than dispatched because it is a two-file index change with no code in it and nothing a review gate protects. Cost if wrong: two files return to history, trivially reversible. Adding an explicit instruction to future dispatches not to commit the report.

Task 5 review: spec ✅ compliant, quality **Approved**. 0 Critical, 0 Important, 1 Minor. 206 tests, unchanged as expected — this task adds none, its verification is the build runs.
Task 5 reproducibility verified by attack, not assertion. Hash `7b2e67c5cb918aa58b9ef91a433ae3e40944c7a26d0367641410ac44775f6cc7` held across: two runs to different output paths; a build from a copy of the directory at a different absolute path; and a rebuild after resetting every file's mtime to 2001-01-01. The reviewer also went past the requirement and found the raw archive **bytes** identical across all four runs (`0af5378…`), which `portable: true, noMtime: true` buys but which the hash does not depend on — the hash is over `path\0size\0sha256` per file, so this is a bonus property rather than a load-bearing one.
Correction to my own record, caught by the reviewer: my Task 5 dispatch said "a correction the brief already carries — the brief requires the shared build logic to live in `scripts/lib/build-package.ts`". **It did not.** Ruling P2 amended Task *12*'s text, not Task 5's, so the extracted Task 5 brief never contained that instruction; the implementer complied because my dispatch told it to, not because the brief did. Outcome correct, statement wrong. Worth recording because "the brief already says X" is exactly the kind of claim an implementer will not go and check.
Task 5: minor (deferred): a missing directory and a directory lacking `manifest.json` both surface as the same raw `ENOENT ... manifest.json`, so the two are indistinguishable from the message alone. Still meets the bar — clear message, exit 1, no stack trace, no partial file written.
Task 5: complete (commits e62bc14..49ecb08, review clean).

Task 6 review: spec ✅ compliant, quality **Approved**. 0 Critical, 0 Important, 0 blocking. 210/210.
Task 6 — all three migration-safety points confirmed by direct evidence rather than assertion: the `problem_revisions` block is **byte-identical** between the 0002 and 0003 snapshots (diffed programmatically), `git diff` over the three prior `.sql` files and their snapshots is **empty**, and `_journal.json` gained exactly one appended entry. That was the failure I most wanted independently checked, because forward-only migrations make a modified prior file the hardest thing here to recover from.
Task 6 — both tests mutation-tested against the applied schema rather than read: flipping `ON DELETE cascade` to `no action` failed the cascade test with a real FK violation, and removing the composite primary key failed the duplicate-path test with "promise resolved [] instead of rejecting". Neither silently passes against the broken schema it exists to catch.
Task 6 watch item (not this task's doing): `apps/judged/test/job-store.spec.ts` failed once in one of two full-workspace runs and passed in isolation immediately after. The diff touches nothing in `apps/judged`. Same shape as Phase 1's unreproduced worker.spec flake — testcontainer/Podman contention under full-workspace parallelism. Recording rather than chasing: it is unrelated to this diff, but if it recurs the fix is the one Phase 1 applied, explicit timeouts rather than inherited defaults.
Task 6: complete (commits 49ecb08..a87e45d, review clean).

Task 7 review: spec ✅ compliant, quality Approved with findings. 0 Critical, 0 Important, 1 Minor. 216/216. Reviewer built an eleven-row acceptance matrix by experiment across all four methods — absolute paths, 64-char non-hex, uppercase hex, trailing slash, embedded NUL, `..` appended, 63/65 lengths, embedded `../` — and confirmed **no entry point ever reaches the filesystem with an unvalidated path**, checking by diffing the parent directory's listing before and after an attempted `put('../escape', …)`.
Task 7 — both disclosed choices judged correct. Leaving `has()` as `readFile` satisfies the brief's stated condition (validation still runs). Not wiring the Nest provider was verified safe rather than assumed: grep shows zero references to `PACKAGE_STORE`/`PackageStore` outside the store file and config, so nothing attempts to `@Inject` it and nothing is half-configured at boot. The store is constructed with a plain argument, so the explicit-`@Inject` constraint does not bind here.
Ruling T7-A (Minor, and my brief's code verbatim): `has()` swallows `pathFor`'s validation error in a bare `catch`, so a malformed hash returns `false` — indistinguishable from a genuinely absent package. Not a traversal hole; the guard runs before any fs access. But `put`, `get` and `delete` all reject while `has` alone stays quiet, and the next two callers are exactly the ones that would be misled: Task 9's upload controller may pre-check with `has()` before writing, and Task 10's fetch client runs in a different process. A caller handed garbage would proceed believing the package merely absent, and an eviction pass would silently skip malformed keys. Fixing now rather than after two consumers are written against the wrong semantics. Cost if wrong: one hoisted line.
Task 7 fix round 1 re-review: ADDRESSED — hoist confirmed at package.store.ts:39, malformed hashes throw, well-formed-absent still returns `false`, other methods untouched, 217/217.
Ruling T7-B — **the re-reviewer skipped the one item I flagged, so I probed it myself and it is real.** I asked specifically whether the permitted `readFile` → `stat` switch changed behaviour for a *directory* at the package path; the report listed the switch as permitted and asserted no behaviour change without testing that case. Probed directly: with a directory at `<root>/<shard>/<hash>`, `has()` now returns **true** and `get()` then throws **EISDIR**. The `readFile` version returned `false`. So the fix round introduced a small divergence nobody intended. Not reachable through our own code — `put` creates the shard directory and writes the hash as a file, never a directory at that path — so this needs an external actor or a future eviction bug. But "`has()` says yes, `get()` fails" is precisely the inconsistency that turns a 404 into a 500 and costs an afternoon. Fixing with `(await stat(path)).isFile()`. Cost if wrong: one predicate on a path that must be a file by construction.
Task 7 fix round 2: implementer DONE (commit 3ece240), 218/218. It agreed with the reasoning before applying rather than complying silently, which is what I asked for.
Ruling T7-C (process, disclosed): I verified fix round 2 **myself** with a four-case probe instead of dispatching a scoped re-review — directory at the package path → `false`, real file → `true`, well-formed absent → `false`, malformed → throws. All four correct. The skill lists "the fix was small, skip the re-review" as a rationalization and it is usually right, so this is a deliberate exception rather than a lapse: the change is a single predicate, I am the controller rather than the implementer so it is not self-review, and the probe I ran is strictly more discriminating than the re-review that missed this exact case one round earlier. Cost if wrong: an unreviewed one-line change reaches the final whole-branch review, which sees it anyway.
Task 7: complete (commits a87e45d..3ece240, review clean after 2 fix rounds).

Task 8: implementer DONE_WITH_CONCERNS (commit a005a59). 222/222, all gates green. Bridge handshake now awaits `verifyJudge` before registering or replying, fails closed on `false` or a throw, and Phase 1's displaced-connection handling is preserved. Both sides delegate to one shared `verifyJudgeCredential(db, name, token)` in `@qhhoj/db` rather than duplicating — the implementer applied this plan's own Ruling P2 precedent unprompted.
Task 8 verification quality: fail-closed was **mutation-verified on both sides** — it temporarily forced accept-on-error and ignore-result and confirmed the right tests went red, then reverted. Log non-leakage was verified **empirically rather than by inspection**: the test runs the real `requestLogger`, sends the token over the wire, and asserts the captured pino output never contains it. The existing `req.headers.authorization` redaction already covers the new `Judge` scheme unchanged.
Task 8 caught a defect in my brief: it said to hash the token "the same way the seed does", but **no seed script exists** — that instruction was unsatisfiable as written. It adopted the codebase's existing `hashToken` convention (sha256-hex) and disclosed the substitution rather than inventing one silently. Compared with `timingSafeEqual`, never `===`.
Ruling T8-A (concern 2 — a real architectural gap, and mine): in the assembled app the **global `AuthGuard` runs before any controller-scoped guard**, so a request carrying `Authorization: Judge <name>:<token>` is rejected 401 before `JudgeGuard` ever executes. My constraint said the route must not be `@Public()`, which is correct in spirit — a judge route is not public — but I never said how AuthGuard is supposed to stand aside. Ruling: Task 9 introduces a distinct metadata marker (**not** `@Public()`) that `AuthGuard` honours by deferring to route guards. `@Public()` would work mechanically and is the wrong answer: it means "no authentication", which is a lie for a route requiring judge credentials, and it would silently become true if someone later removed `@UseGuards(JudgeGuard)`. A distinct marker keeps deny-by-default honest and the route's intent legible. Cost if wrong: one decorator and one metadata check.
Ruling T8-B (concern 3 — a real gap in the plan): **no task seeds `judge_nodes`.** I closed the authentication hole without providing any way to provision a credential, so the compose judge (`judge-1` / `phase1-judge-key`) will now fail to authenticate against a fresh database. That is a self-inflicted outage waiting at Task 13. Ruling: Task 12's seed registers the judge node from an env-supplied token, and Task 13 wires `JUDGE_TOKEN` through compose and `.env.example` for both the judge and the seed. Folding into both briefs before they dispatch. Cost if wrong: caught immediately at Task 13 bring-up, which is where the implementer predicted it would surface.
Task 8 concern 1 accepted: `main.ts` and 13 call sites in `dmoj-driver.spec.ts` changed outside the brief's file list, forced by making `verifyJudge` a **required** field on `BridgeOptions`. That is the right call — an optional field defaulting to accept would reopen the fail-open hole the task exists to close.
Task 8 review: spec ✅ compliant, quality Approved with findings (opus). 0 Critical, 0 Important, 1 Minor. 222/222 tallied by the reviewer from its own run.
Task 8 — all six scrutiny points confirmed by reproduction rather than reading. It independently reproduced the **fail-open mutation** (inserting `verified = true` after the try/catch made bridge tests 2 and 3 fail, exactly the signature of the hole this task closes) and the **displaced-connection mutation** (unguarding the close handler's identity check made the old socket's FIN evict the new live connection — the precise Phase 1 bug — failing with `expected +0 to be 1`). It also probed a **malformed handshake**, for which no test exists: `verifyJudge(undefined, undefined)` closes the socket and registers nothing, protected at two independent layers, since `eq(name, undefined)` compiles to `"name" = NULL` (confirmed by dumping the SQL) and `hashJudgeToken(undefined)` throws into the outer catch.
Task 8 — log non-leakage confirmed on **both** surfaces separately, which matters because a socket handshake never touches the HTTP logger. API side: the test installs the production `requestLogger` with a captured destination and asserts *positively* on `"req"`, `[redacted]` and the URL before asserting absence, so an empty capture cannot make it pass vacuously. Bridge side: `bridge-server.ts` contains zero logging calls, no drizzle query logger is enabled, and the only query parameter is the judge *name*.
Ruling T8-C (Minor, fixing because it compounds with T8-B): a rejected handshake produces **zero operator signal**. Correct at the wire level — the brief said send nothing — but combined with nothing yet seeding `judge_nodes`, the first `compose up` gives a connect/reject/retry loop with no line anywhere explaining why. An operator sees "judge never connects" and has nothing to grep for. Tasks 12 and 13 remove the trigger but not the blindness: a mistyped key next month produces the same silence. One line carrying the judge id and a reason, never the key.
Task 8 carried finding (for Task 12): the shared-hash convention's only enforcement is that `hashJudgeToken` is exported. Whoever writes the seeder must **import** it rather than reimplement sha256 — a second implementation is exactly how the stored hash and the presented hash drift apart, and the symptom would be a judge that authenticates nowhere with no obvious cause.
Task 8 fix round 1 re-review: ADDRESSED, no new defects. Verified with **actual captured output** rather than inference. Plain rejection logs `{"msg":"judge handshake rejected","id":"judge-1","reason":"credential rejected"}`; a thrown verifier logs the same with `"reason":"verification error"` plus `error: {name, frames}` — constructor name and stack frames only, never `.message`, so Drizzle's query text and bind parameters cannot ride along. Registered-with-wrong-key and unknown-judge produce **identical** reasons, so nothing became a judge-name oracle. Both mutations reproduced, including the one that matters: adding `key` back to the logged object failed the absence assertion with `super-secret-do-not-log-me` visible in the output. Wire behaviour unchanged — nothing sent, not registered, broadcast unreachable.
Task 8: complete (commits 3ece240..175dc74, review clean after 1 fix round). 223 tests.

Task 9 review: spec ✅ compliant (A1 and A2 both verified structurally), quality Approved with findings (opus). 0 Critical, 2 Important, 4 Minor. 234/234, both generators re-run with zero drift.
Task 9 — A1 verified **independently and structurally**, not from the report: the reviewer built a route carrying `@JudgeRoute()` with no route guard, confirmed anonymous access gets 401, then mutated `AuthGuard`'s judge branch to `if (false && …)` and watched that test go red while the admin-session test stayed green. So the enforcement genuinely lives in `AuthGuard` rather than being borrowed from `JudgeGuard`, and defence in depth is real rather than redundancy. `@Public()` and the default-deny path confirmed unweakened.
Task 9 — **the symlink-smuggling attack was real, and the reviewer built it.** `packDirectory` is `isDirectory() → recurse, else if isFile() → push`, silently dropping everything else. It constructed a tar containing `manifest.json`, two test files and a relative symlink `evil.link → tests/01.in`, with the claimed hash computed under `packDirectory` semantics so the three regular files hashed to exactly the claimed value. Against the shipped hand-rolled walker: **422 `package_invalid_entry`**. Had verification reused `packDirectory`, that archive would have been accepted, stored, and shipped to judges with an unhashed symlink inside. The implementer identified this unprompted and was right.
Task 9 — the 9 unverified tests: the reviewer mutation-closed **6 of 9**, each against only its own spec with a `git diff` check between runs. Notably the two A2 maps discriminate independently (disabling `byLower` reddens only the case test; disabling `byNfc` only the NFC/NFD test), and dropping `onConflictDoNothing()` reddens idempotency. No vacuous test found. It also confirmed the implementer's own caveat exactly: with `AuthGuard`'s judge check disabled the admin-401 test stays green, so that test genuinely cannot isolate the mechanism — documenting rather than conflating was correct.
Ruling T9-A (Important 1): **any malformed archive answers 500 `internal_error` and writes an error log** — on the endpoint whose entire job is rejecting bad input. `unpackArchive` is unwrapped, so a zstd/tar failure falls through `ProblemFilter` to its 500 branch. Reproduced four ways, all authenticated-user-triggerable: garbage bytes, an empty body, an absolute-target symlink, and a `../` traversal archive — the last reporting "the server broke" for precisely the hostile case the guard exists to catch. It is also off-contract; the route declares only 201/401/422. And it is a cheap alert-noise primitive: one ERROR line per malformed request. Fixing with a 422.
Ruling T9-B (Important 2): **the 256 MiB cap's 413 is never delivered.** `req.destroy()` runs before the rejection reaches `ProblemFilter`, so no status and no body are ever written — the reviewer set the limit to 16 bytes, uploaded 4 KiB, and got `socket hang up`. The memory bound itself works; the entire error contract for it is dead code, which is exactly what an untested path hides. Fixing, and pinning with a small-limit test.
Ruling T9-C (Minor 3 — **my spec gap, not an implementation defect**): A2 misses collisions needing case-folding *and* normalisation together. `CAFÉ.txt` (NFC) versus `café.txt` (NFD) are unequal under `toLowerCase()` alone and unequal under `normalize('NFC')` alone, but equal under both — and they collapse on a default macOS APFS volume, producing exactly the silent-merge integrity failure A2 exists to prevent. The implementation matches my addendum literally ("equal after `toLowerCase()` **or** after `normalize('NFC')`"), so this is my wording. One more map keyed on `normalize('NFC').toLowerCase()`; purely additive, cannot reject anything the existing two accept.
Ruling T9-D (Minor 4): a comment claims CI keeps the internal route out of `openapi.json` and the SDK. CI only regenerates and `git diff --exit-code`s — it enforces that the artifacts are *in sync*, not that they are *free of* that path, so nothing would fail if someone registered it later and the comment would then be actively misleading. One assertion in the contracts test makes it true.
Task 9: minor (deferred): narrow `sizeBytes` drift — if a first upload's `store.put` succeeds and its transaction fails, a later re-upload of a recompressed byte-different archive skips the put but inserts the new length, so the row describes bytes never stored. Needs a specific crash window plus recompression.
Task 9 fix round 1 re-review: all four ADDRESSED, no new defects, tree clean after three mutation/revert cycles. Each pre-fix failure reproduced independently: removing the try/catch gave `expected 500 to be 422`; reverting the destroy-timing gave `Error: socket hang up`; registering a fake `/internal/` path failed the new structural assertion. The NFC/NFD fixture confirmed genuine — `'CAFÉ.txt'` / `'café.txt'` as real escapes, not literals an editor could have unified, which was the specific vacuity trap I flagged. `configOverrides` confirmed test-only: `buildApp` is referenced solely from specs and `main.ts` calls `loadConfig` directly, so it cannot weaken production config. Both generators re-run with zero diff.
Task 9: complete (commits 175dc74..21986b0, review clean after 1 fix round). 239 tests.

Task 10: implementer DONE (commit 90e1c9f). 244/244 (239 + 5). Built `apps/judge-agent`: plain `node:http`, `Materializer.ensure(hash)` fetches with `Authorization: Judge {name}:{token}`, unpacks into a hidden `.tmp-<hash>` staging dir *inside* PROBLEMS_DIR, renders `init.yml`, and renames into place. Every failure path removes the staging dir; hash regex-validated before becoming a path component; concurrent `ensure()` calls for the same hash coalesce into one in-flight attempt.
Task 10 — atomicity claim is **weaker than the others**: verified "by code inspection" (same parent ⇒ same filesystem ⇒ atomic rename) plus tests asserting no partial state survives, but not by experiment. That is the load-bearing property of this task, so the review is asked to test it rather than reason about it.
Task 10 — credential handling verified by grep across all source: the token appears exactly once, in the outgoing fetch header, never in a URL or log; all error logging routes through `describeError`, which structurally excludes `.message`. A test asserts the URL never contains the token.
Task 10 self-caught bug worth recording: the first draft's JSDoc quoted the judge's glob as `*/init.yml`, and the literal `*/` inside a block comment closed it early, cascading syntax errors through the file. Caught before the first successful typecheck. Not a brief defect — but a good reminder that documenting a glob inside a block comment is its own hazard.
Task 10 disclosures accepted: no Dockerfile or compose wiring (Task 13 owns that, and the brief's file list excludes it); HTTP status choices for `/packages/ensure` (400 bad input, 502 materialise failure) were the implementer's judgement since the brief specified only the 204 success case.
Task 10 review: spec ✅ compliant, quality **Approved**. 0 Critical, 0 Important, 1 Minor. 244/244 summed from its own run.
Task 10 — atomicity **tested rather than reasoned**, which is what the code-inspection claim needed. Reviewer confirmed `st_dev` equality between staging and final directories (ruling out a cross-device rename silently degrading to copy-then-delete), checked the **real judge-server fork** rather than my description to establish the effective glob is `/problems/*/init.yml` and that Python's `glob.iglob` does not match dotfiles with `*`, and polled `problemsDir` across 5 runs confirming the undotted `<hash>` directory never appears without `init.yml` already inside. The judge can observe "absent" or "complete", never partial.
Task 10 — all four failure paths verified empty: rejected fetch and corrupt archive from the shipped suite, plus a 403 response and a manifest-schema failure the reviewer added itself. Hash validation confirmed to run before touching the in-flight map or the filesystem, rejecting `../escape`, absolute paths, uppercase hex and a 63-char string with zero fetch calls.
Task 10: minor (deferred), and it is **my brief's gap**: the prescribed no-op test calls `ensure()` sequentially, so the `inFlight` coalescing that guards two racing callers is never exercised by the shipped suite. The implementer followed my skeleton verbatim. The reviewer verified the property itself — 3 concurrent calls with a delayed fetch stub produced exactly 1 fetch and all 3 resolved — so the behaviour is correct but unpinned.
Task 10: complete (commits 21986b0..90e1c9f, review clean).

Task 11: implementer DONE (commit 458ccf2). 252/252 (244 + 8), judged 53/53. `hashToProblemCode` and `PROBLEM_CODE` deleted; `problem-id` is now the package hash. `HttpAgentClient` wraps `POST /packages/ensure` with a bounded `AbortSignal.timeout` (60s). `BridgeServer` records each judge's announced problem set via `problemsFor(id)`, replacing rather than merging, cleared on displacement, sweep eviction and teardown.
Task 11 — ordering test **mutation-verified**: broadcasting before ensuring failed with `expected ['broadcast','ensure','broadcast'] to deeply equal ['ensure','broadcast']`, then restored byte-identical. That is precisely the failure a co-occurrence assertion would have missed.
Task 11 unprompted improvement: it moved `ensure` **before registering the live entry**, not merely before broadcast, so a failed ensure leaves nothing live and a later `cancel` no-ops rather than acting on a phantom job. I had only specified "before broadcast".
Task 11 honesty note carried to review: tests and implementation were written together rather than test-first, so **only the ordering test was empirically observed failing**. The other four are argued to fail "by construction" against the old tree — an assertion the old mapping could not produce, a method that did not exist, an `ensure` never called — but were not run against a stashed old tree. Plausible, unproven. This is the exact gap that produced two vacuous tests in Phase 1, so the review is asked to close it by mutation.
Task 11 review: spec ✅ compliant, quality **Approved**. **Zero findings** — first task this phase with none at any severity. 252/252 summed from its own run.
Task 11 — the disclosed gap is **closed by mutation**. All four previously-unverified tests went red against their specific broken implementations: reintroducing a mapping broke the problem-id test, swallowing `ensure`'s rejection broke the no-broadcast-on-failure test, and skipping either recording site broke its own test. The "fails by construction" reasoning held.
Task 11 — the reviewer added a **fifth mutation I had not asked for**: changing the later-packet recording from replace to merge, which failed with `Set{'aplusb','other-problem'}` against expected `Set{'other-problem'}`. That is the distinction that actually matters — a judge which dropped a package must not appear to still have it — and nothing in my brief would have caught a merge.
Task 11 — two properties verified by experiment rather than reading: the `ensure` timeout is real (a never-settling fetch rejects in ~29ms under a 20ms bound), and a failed `ensure` leaves no phantom entry (throwaway test forced `ensure` to throw, then called `cancel` and confirmed the judge received zero packets — a clean no-op).
Task 11 — Phase 1's displaced-connection handling and Task 8's handshake verification both confirmed intact **by passing test**, not by resemblance, in the file this task edited. `problemsFor` confirmed recorded but unread: nothing routes on it yet, correctly deferred to Phase 4.
Task 11: complete (commits 90e1c9f..458ccf2, review clean, no findings).

## STOPPED — session limit (resets 20:50 Asia/Ho_Chi_Minh)
Task 12's implementer terminated on an API session limit before doing any work. Verified: HEAD is 458ccf2, working tree clean, nothing partial. Task 12 has NOT started.
Resume point: dispatch Task 12 with brief `.superpowers/sdd/2026-08-18-phase-2a-packages/task-12-brief.md` (addendum B1/B2 already appended), BASE 458ccf2.
State at stop: Tasks 1-11 complete, **252 tests**, all gates green. Remaining: 12 (seed + FK), 13 (compose), 14 (end-to-end, second problem), 15 (acceptance), then final whole-branch review.

Task 12: implementer DONE (commits 7a52732, a6cd486). 254/254 (252 + 2), all gates green. Seed builds and registers the real package via the shared `scripts/lib/build-package.ts`, repoints the revision, and seeds `judge_nodes` from `JUDGE_TOKEN` using the imported `hashJudgeToken`. FK added after the data moves. Six pre-existing test fixtures fixed to satisfy the new constraint. `.env.example` and `docs/runbook.md` updated.
Ruling T12-A — **delete the unverified upgrade procedure rather than ship it.** The implementer found a real constraint: Drizzle's migrator applies all pending migrations in one transaction, so `migrate` cannot land 0003 (create tables) without also attempting 0004 (the FK), and 0004 fails until the seed has repointed the `phase1-aplusb` row. It documented a workaround — temporarily withhold 0004's file, migrate, seed, restore, migrate again — and honestly labelled it **unverified**. That labelling is exactly right and is why it must not ship: an unverified procedure in a runbook is worse than none, because someone will follow it during an incident and discover it does not work.
Ruling T12-A (the resolution): this project's own premise settles it. The user's founding constraint was that **old data does not matter** — it lives on a remote server and migration happens later. So a Phase 1 dev volume is disposable, and the honest runbook instruction is "recreate the volume", not a four-step dance nobody has executed. Replacing the procedure with that. Cost if wrong: someone with a dev volume they care about loses it, having been told plainly to expect that — rather than following a procedure that silently fails.
Task 12 disclosures accepted: `.env.example` (`JUDGE_TOKEN`), runbook, six pre-existing test fixtures repaired for the new FK (required to keep the suite green), and two new tests satisfying addendum B1's explicit requirement.
Task 12 review: spec ✅ compliant (B1 and B2 both verified independently), quality **Changes required** — one Critical, which is the T12-A ruling not yet applied. Being precise about attribution: I issued T12-A *after* the implementer's final commit, so this is a new instruction rather than one ignored. Its commit a6cd486 corrected an overclaim in that section but could not have applied a ruling it never received.
Task 12 — ordering verified in **both directions** by the reviewer rather than trusted: seeding then applying 0004 succeeds, and applying 0004 against a row still holding `phase1-aplusb` fails with `Key (package_hash)=(phase1-aplusb) is not present in table "packages"`. Migrations 0000-0003 confirmed byte-identical to pre-task and the journal change a pure append.
Task 12 — the reviewer tested a case the implementer's own suite did not: re-running the seed with a **different** token left the stored hash unchanged, confirming `onConflictDoNothing` rather than upsert, so a re-seed cannot silently rotate a judge's credential. It also independently recomputed the stored hash against `hashJudgeToken` and confirmed a missing `JUDGE_TOKEN` exits 1 with no fallback.
Task 12 — all nine fixture insert sites across six files inspected individually: each now inserts a real stub `packages` row before the referencing `problem_revisions` insert. **No assertion was weakened to satisfy the new constraint**, which was the specific risk I asked about.
Task 12 fix round 1 (commit 86c869b): unverified upgrade procedure replaced with "recreate the volume", stated plainly as destructive and explaining why that is acceptable here. Verified by me directly rather than dispatched — one grep on a documentation-only change is cheaper and more decisive than a re-review. The only remaining match for the old wording is line 485, an unrelated and legitimate "not independently verified" note about `docker compose` behaviour. The verified already-at-0003 path was kept. 254 tests unchanged, one file changed.
Task 12: complete (commits 458ccf2..86c869b, review clean after 1 fix round).

Task 13: implementer DONE (commit cd1545a). 254/254 unchanged, all gates green. Full stack up under `scripts/compose-up.sh` with every service healthy; judge handshakes (`Judge "judge-1" online: [judged]:9999`, preceded by real rejections before seeding — so the auth path was observed working in both directions); judge-agent answers `/healthz` both locally and from judged's actual `AGENT_ORIGIN`; and `POST /packages/ensure` against the real seeded hash returns 204 and atomically materialises `tests/` plus a freshly generated `init.yml`.
Task 13 — **two integration bugs surfaced only by bringing the stack up**, both invisible to 254 passing tests:
 1. `apps/api/Dockerfile`'s deps stage never copied `packages/package-format/package.json`, so a real image build failed typecheck. Latent since Task 9.
 2. `materializer.ts` built its archive-fetch URL without apps/api's global `/api/v1` prefix, so **every real fetch 404'd**. No unit test caught it because none asserted against a real Nest app — the same class as Phase 1's Caddy `/ws` defect, where the suite was green while the integration was broken.
Ruling T13-A (structural, for the final review): the stale Dockerfile COPY manifest is a **repeat**. I fixed exactly this in Phase 1's final cleanup and it recurred here for the identical reason — a new workspace package added, the per-package `COPY` list not updated. A patch re-applied every phase is not a fix. The final whole-branch review should consider whether the deps stage should copy manifests by glob, or whether a check should fail the build when a workspace package is missing from the list. Not fixing mid-task: it touches image build shape and deserves the final review's attention rather than a rushed change here.
Task 13 also closed a gap it found: `scripts/seed-problem.ts` registered package rows but never wrote the archive bytes anywhere, so a seeded package existed in the database and nowhere on disk. Added `scripts/lib/package-store.ts` and made `PACKAGE_STORE_DIR` required. And it recomputed the `aplusb` hash in the seed spec, since deleting `init.yml` changes the package contents and therefore its identity — a consequence I should have anticipated when I sequenced the deletion here.
Task 13 concern accepted, unrelated: the stale `phase-1-skeleton` Caddy container was stopped to free ports 8080/8443 and could not be restarted, because I deleted that worktree earlier. Pre-existing, exposed rather than caused.
Task 13 review: spec ✅ compliant across C1-C4 and items 5-7, verified **against the running stack** — process lists, port bindings, filesystem mounts, DB rows, log transitions, direct blob listings. Quality Approved with findings: 1 Important, 1 Minor. 254/254 re-run by the reviewer.
Task 13 — authentication proven by a **reject→accept transition**, not by a connection: `judged`'s log shows four `"judge handshake rejected","reason":"credential rejected"` entries from before the seed ran, then `Judge "judge-1" online` after the row was seeded. That is the bridge actually checking, not merely accepting. The agent's credential verified by effect rather than log-reading: the package rows exist and `/problems/<hash>/{init.yml,manifest.json,tests/}` is materialised inside the judge container.
Task 13 — C2 confirmed from `/proc` inside the container: pid 1 `tini`, pid 10 the agent, pid 2 the dmoj judge, all in one container with no sidecar; `/problems` and `/` are the same overlay mount, so Task 10's atomic-rename guarantee survives the move into the judge image.
Ruling T13-B (Important — and the answer to the question I asked): **the URL-prefix regression is not pinned by any test.** `materializer.spec.ts:83` asserts against a mocked fetch using a hardcoded expected URL, so it compares two independently-hardcoded literals that never drift relative to each other — it pins the string against itself. `app.harness.ts` never calls `setGlobalPrefix`, so `packages.spec.ts` exercises `/internal/packages/...` **unprefixed**, a URL shape the agent never requests. And `app.smoke.spec.ts`, which does boot the real prefix, only asserts `/api/v1/auth/me` and never touches the internal controller. So changing `setGlobalPrefix('api/v1')` to any other value leaves all 254 tests green while every real archive fetch 404s. This is the **third** time this phase a green suite has coexisted with a broken integration (Caddy `/ws` in Phase 1, the Dockerfile COPY manifest, now this). Fixing both halves: an assertion through the real prefix, and hoisting the literal so three copies become one.
Task 13: minor (deferred, disclosed tradeoff): `judge/entrypoint.sh` backgrounds the agent, waits once for `/healthz`, then `exec`s into dmoj — so nothing restarts the agent if it dies later. The healthcheck marks the container unhealthy after ~60s but `restart: unless-stopped` does not act on health alone. Correct for the brief's "simplest arrangement without an init system", and the startup path fails loud (`set -eu`, bounded wait, non-zero exit).
Task 13 fix round 1 re-review: ADDRESSED. Discrimination reproduced exactly — changing the prefix to `api/v2` failed **both** smoke assertions with `expected 404 to be 401`, then restored green. All three consumers confirmed importing `@qhhoj/api-prefix` with no re-declaration.
Task 13 — the recurring trap **did not recur, and this was verified by building rather than reading**: both `apps/api/Dockerfile` and `judge/Dockerfile` were rebuilt `--no-cache` end to end and succeeded, with the log showing `packages/api-prefix typecheck: Done` inside the filtered typecheck step. All four throwaway images removed; the running stack's own images and containers confirmed untouched by ID.
Task 13: minor (deferred, pre-existing): `packages/contracts/src/registry.ts:9` still hardcodes `'/api/v1'` as the OpenAPI `servers` URL. Confirmed by `git log --follow` to predate this round and to be untouched by both commits. It is documentation metadata rather than a routing path, so it was not one of the three copies the finding named — but it means "single-sourced" is not literally true codebase-wide.
Task 13: complete (commits 86c869b..df56c95, review clean after 1 fix round). 256 tests.

## Task 14 — THE ACCEPTANCE. IT WORKS.
Verified by me directly, not taken from the report:
```
correct  → AC 3/3
wrong    → WA 1/3
broken   → IE | compileOutput: <real g++ diagnostic>
hello    → AC 3/3
all four paths behaved as expected
```
`ls /problems/` inside the judge container shows **both** hashes — `0f61232b…` (hello) and `73d40a7e…` (aplusb). Commit 947fca8, 256/256, all gates green.
Task 14 — the fetch proof is the part that matters and it was produced properly: BEFORE the submission only aplusb's directory existed and hello's was absent; AFTER, hello's existed containing `init.yml`, `manifest.json` and `tests/`, freshly materialised by the agent. Re-checked after a later run with the same mtime, confirming it persisted rather than re-fetching. Without that pair, a second problem grading would only prove something pre-seeded it.
Task 14 — the three `aplusb` verdicts are unchanged from the Phase 1 baseline, and the implementer confirmed that by running them *before* making any Task 14 edits. Those submissions now travel an entirely different substrate — fetched by hash, materialised by the agent, `problem-id` a hash rather than a directory name — so an unchanged result across a swapped substrate is the strongest available evidence the substitution is sound.
Ruling T14-A (operational trap worth keeping): the `migrate`/`api` image is a `COPY . .` snapshot, so a **stale image silently re-seeded `aplusb` instead of `hello` with no error at all**. Not a crash — it quietly did the previous thing. The implementer caught it, rebuilt, force-recreated, and documented it in the runbook. This is the worst failure shape available in a container workflow and it will recur for anyone editing a script without rebuilding.
Task 14 — `problems/*.meta.json` deliberately kept **outside** the packed directory so seeding metadata cannot affect the package hash. Good instinct: putting it inside would have changed the content hash and silently invalidated every stored reference.
Task 14 flake watch (third sighting): `apps/judged/test/dmoj-driver.spec.ts` failed once on a `vi.waitFor` timing assertion under heavy concurrent load, passing in isolation and on two subsequent clean runs, on a task touching nothing in `apps/judged`. Earlier sightings: `job-store.spec.ts` at Task 6, and Phase 1's unreproduced `worker.spec.ts`. Same shape each time — testcontainer contention under full-workspace parallelism. Carrying to the final review as a pattern rather than an incident.
Task 14 review: spec ✅ compliant, quality Approved with findings — 1 Minor (a stale doc cross-reference), no Critical or Important. 256/256 re-run twice.
Task 14 — **the fetch evidence holds, and the reviewer proved it structurally rather than narratively**: `seed-problem.ts` writes only DB rows and the API-side package store and never touches the judge's filesystem; the only writer of `/problems/<hash>/` is the materialiser's `ensure()`, reachable only via the agent's endpoint, called only by `judged` before each dispatch; and there is no eager materialisation at agent startup. So seeding *structurally cannot* have created that directory — the before/after observation genuinely distinguishes fetched-on-demand from pre-seeded.
Task 14 — `hello` confirmed genuinely distinct, not a disguised copy: `aplusb` is integer arithmetic (`"1 2"→"3"`), `hello` is string I/O (`"World"→"Hello, World!"`), exercising a different checker path and a different solution shape.
Task 14 — the strongest single piece of evidence, and better than what I asked for: **`aplusb`'s hash is unchanged at `73d40a7e…` despite `aplusb.meta.json` being newly added as a sibling.** That proves the meta file does not leak into the content hash, rather than merely asserting it sits outside the packed directory.
Task 14 — the e2e script confirmed to **assert, not print**: the `hello` block pushes to `failures` on verdict/points/maxPoints mismatch exactly as the three `aplusb` blocks do, and the script exits 1 if any failure is recorded. The three `aplusb` assertion blocks confirmed untouched by diff.
Task 14 — runbook claims spot-checked against reality: the reviewer read `/judge/dmoj/packet.py` **inside the live container** and confirmed the documented backoff verbatim (`fallback = 4`, then `min(fallback * 1.5, 60)`), plus the unbounded retry on authentication failure.
Task 14: complete (commits df56c95..947fca8, review clean).

## Task 15 — Phase 2a acceptance

**D1 fixed first**, before any gate run, so the clean-install gate covers the
final state of every source file this phase touches: `scripts/e2e-submit.ts:36`'s
comment cited the runbook heading as `"A second problem: hello"`; the real
heading (`docs/runbook.md:575`, itself already corrected by Task 14's Minor
finding) is `"A second problem: building, uploading, and diagnosing a
package."` Fixed, no code behaviour changed.

**Step 1 — clean-install gate, genuinely torn down.** `node_modules` (root
and every workspace package/app), every `*.tsbuildinfo`, and every `dist/`
directory removed and their absence confirmed by `find` before installing —
zero hits for all three. `corepack pnpm install --frozen-lockfile` succeeded
outright (lockfile not stale). `corepack pnpm -r typecheck`,
`corepack pnpm -r lint`, `corepack pnpm -r test`, `corepack pnpm
typecheck:scripts`, `corepack pnpm lint:scripts` all green, run as separate
commands with output inspected directly rather than relayed. **256/256**,
summed from the per-package tallies in the run (judge-protocol 18,
api-prefix 1, contracts 5, observability 4, realtime 1, package-format 25,
sdk 2, db 14, judge-agent 5, judged 53, web 15, api 113 = 256), matching the
count entering this task exactly. **No flake this run** — the third-sighting
pattern (worker.spec.ts, job-store.spec.ts, dmoj-driver.spec.ts) did not
recur under this session's full-workspace run; this is one clean data point,
not evidence the pattern is gone, and it is recorded as exactly that in the
runbook and in D3 below rather than claimed as a fix.

**Step 2 — acceptance criteria, each checked against fresh or clean-run
evidence, not carried forward from earlier tasks' say-so:**

1. **Met.** The clean-install gate above.
2. **Met, freshly proved.** `problems/hello` built twice via
   `scripts/package-build.ts` into two separate output paths this session:
   both printed `{"hash":"0f61232bbd7b9c76c908e0b53d11478d498f90fab55e4deabf53e8c102c80721","files":7,"bytes":397}`, byte-for-byte identical.
3. **Met.** `apps/api/test/packages.spec.ts`'s `"rejects an archive whose
   contents do not match the claimed hash"` (422 `package_hash_mismatch`),
   passing in the clean run. `PackagesService.upload`
   (`apps/api/src/packages/packages.service.ts:115-175`) re-derives every
   file's digest from what actually extracted and recomputes the package
   hash from those digests before comparing against the claimed value —
   read directly, not inferred from the test title alone.
4. **Met, at both layers named.** Unpack: `packages/package-format/test/archive.spec.ts`'s
   `"refuses an archive entry that escapes the destination"`. Store:
   `apps/api/test/package-store.spec.ts`'s three `../escape` rejections on
   `put`/`get`/has`. Both files' suites passed in the clean run.
5. **Met, at both surfaces named, plus a mechanism check for "no
   credential" specifically.** Bridge: `apps/judged/test/bridge-auth.spec.ts`
   (4/4 passing) covers a non-verifying key and a throwing verifier, both
   fail-closed. Archive endpoint: `apps/api/test/judge-auth.spec.ts`'s single
   test explicitly covers a missing `Authorization` header and a wrong
   token, both rejected, alongside a positive accept case (1/1 passing). The
   "no credential presented to the bridge" case specifically has no shipped
   automated test (Task 8's review probed it manually and recorded the
   result in this ledger rather than pinning it); read
   `packages/db/src/judge-auth.ts:34-52`'s `verifyJudgeCredential` directly
   to confirm the mechanism: `hashJudgeToken(undefined)` throws inside
   `createHash().update()`, caught by the function's own outer `try/catch`,
   returning `false` — the identical fail-closed path a wrong credential
   takes, not a special case that could silently diverge.
6. **Met.** `apps/api/test/packages.spec.ts`'s `"refuses the archive to a
   user session, however privileged"` — a signed-in admin gets 401
   `judge_unauthorized` from `GET /internal/packages/{hash}/archive`.
   Passing in the clean run.
7. **Met.** `problemsFor(id)` (`apps/judged/src/drivers/dmoj/bridge-server.ts:77`)
   backed by `dmoj-driver.spec.ts`'s `"records problems announced later by a
   supported-problems packet"` and the reviewer's added fifth mutation
   (Task 11 entry above) proving replace-not-merge. Passing in the clean
   run.
8. **Met.** `grep -rn "hashToProblemCode\|PROBLEM_CODE"` across the tree:
   zero matches. `dmoj-driver.ts:113` sends `'problem-id': job.packageHash`
   directly — the hash itself, no lookup table anywhere between them.
9. **Met.** `dmoj-driver.spec.ts`'s `"does not broadcast when ensure fails,
   and rejects so the worker can log it"` — `dispatch` rejects with the
   real underlying error (`'agent unreachable'`), nothing is broadcast to
   the judge. `worker.ts`'s dispatch call is wrapped in a `try/catch`
   (`worker.ts:124-138`) that logs `'job failed'` with the real error and
   lets the job re-lease, rather than the failure surfacing as an opaque
   500 or hanging silently.
10. **Met.** `apps/judge-agent/test/materializer.spec.ts`'s `"leaves no
    partial directory when the fetch fails"` and `"leaves no partial
    directory when the archive is corrupt"`, both passing in the clean run,
    plus Task 10's review-time `st_dev`/atomic-rename verification recorded
    above.
11. **Met, re-run live this session**, not merely cited from Task 14.
    `corepack pnpm exec tsx scripts/e2e-submit.ts` against the running
    `phase-2a-packages` stack: `correct → AC 3/3`, `wrong → WA 1/3`,
    `broken → IE | compileOutput: <real g++ diagnostic, truncated to 80
    chars by the script itself>`, `hello → AC 3/3`, `all four paths behaved
    as expected`. Output pasted verbatim in the Step 1 section of
    `task-15-report.md`.
12. **Met, re-proved live this session rather than cited from Task 14's
    record.** Before the run: `podman exec phase-2a-packages_judge_1 ls
    /problems/` showed only `aplusb`'s hash; hello's hash directory was
    removed by hand first (`rm -rf`) specifically to force a fresh fetch
    rather than rely on Task 14's already-materialised state. After the
    same e2e run above: `ls /problems/` showed both hashes again, and
    `ls -la` on hello's directory showed `init.yml`, `manifest.json` and
    `tests/`, freshly materialised. Removing an already-materialised
    directory mid-session is safe here — `ensure()` runs before every
    dispatch and nothing was in flight — and it is what turns this from "an
    integration exists" into "the fetch-on-demand path was exercised, this
    session, on purpose."

**No criterion is recorded as met on trust.** Every one above cites either a
specific passing test in the clean-install run or a direct, fresh
observation against the running stack.

**Step 3 — docs.** `docs/runbook.md` gained a "Known issues carried into
Phase 2b" section (D2: the Dockerfile COPY manifest trap, the stale-image
silent-reseed trap, and `registry.ts`'s unenforced `/api/v1` copy) and, in
the same section, D3's flake record — three sightings, unreproduced,
unexplained, testcontainer contention named explicitly as a hypothesis and
not a diagnosis, no fix attempted. `README.md` gained "Phase 2a delivers" /
"Phase 2a does not deliver" sections mirroring the existing Phase 0/Phase 1
pattern, and Phase 1's limitations paragraph was corrected in place
(strikethrough plus an update note, the same treatment the README already
used for the Phase 0 compose claim) — the judge-bridge handshake no longer
"never checks the configured key"; Task 8 closed that in this phase. The
other two Phase 1 limitations (`IE` for compile errors, no scheduling
policy) are still true and were left unchanged. This ledger
(`docs/superpowers/ledgers/2026-08-18-phase-2a-packages-ledger.md`) is
committed; `progress.md` itself stays untracked and gitignored, unmodified
by this task.

Task 15: complete. Commit recorded in `task-15-report.md`. **256/256, all
gates green, from a genuinely clean install. 12 of 12 acceptance criteria
met, 0 not met, 0 unverifiable.**

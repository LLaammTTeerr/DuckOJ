# Phase 2b — Problems: design

**Status:** approved for implementation.
**Predecessors:** `2026-08-17-foundation-design.md`, `2026-08-17-phase-1-walking-skeleton-design.md`, `2026-08-18-phase-2a-packages-design.md`.
**Read first:** `docs/superpowers/ledgers/2026-08-18-phase-2a-packages-ledger.md` — its deferred-work table is an input to §9 of this spec.

---

## 1. What this phase is for

Phase 2a made a problem's *test data* a first-class, content-addressed object.
It did not make a *problem* one. There is a `problems` table, a
`problem_revisions` table, and no way to reach either over HTTP: every problem
in existence was inserted by `scripts/seed-problem.ts`.

Phase 2b closes that. It delivers the problem as a managed entity — who owns
it, who may see it, who may edit it, how a package becomes a published
revision, and the web surface for browsing and authoring.

It deliberately stops short of everything that depends on problems but is not
a problem: tags, contests, ratings, editorials, and scheduling policy.

### In scope

- The permission model: `problem_members`, `problem_orgs`, and the visibility
  predicate that every read path shares.
- `ProblemAccessService` — the sole *service* importing guarded problem
  tables, matching `OrgAccessService` and `SubmissionAccessService`
  (`problem.visibility.ts` also holds them, by design — see §3.3).
- Problem CRUD and the revision lifecycle over HTTP: list, read, create,
  update, attach a package, publish.
- Manifest denormalisation onto `problem_revisions` at attach time.
- Web: a problem list, a problem page with a rendered statement, and setter
  forms for authoring and publishing.
- One admin-only route granting the `setter` role, without which none of the
  above is reachable end-to-end.
- Three items of carried debt (§9).

### Out of scope

Problem types, groups, and tags · contest integration · ratings and points ·
editorials and solutions · problem deletion and package garbage collection ·
scheduling policy, priority, and attempt caps · the author-management UI
(the API lands here; the screen lands in Phase 3 with organization
management) · problem cloning and mirroring · `allowed_languages`
per-problem restrictions.

---

## 2. The permission model

### 2.1 Why it is shaped this way

The old DMOJ application models problem people as three separate
many-to-many relations — `authors`, `curators`, `testers` — and problem
visibility as `is_public` plus `is_organization_private` plus an
`organizations` many-to-many.

Data migration from the existing production instance is **deferred, not
dropped** (foundation spec §2). A permission model that cannot represent the
old one loses information at import time, and the import is the one moment
where that loss is irreversible. So the model here is structurally equivalent
to DMOJ's, and merely spelled more compactly: one table with a role column
instead of three tables.

### 2.2 Tables

```sql
CREATE TYPE problem_role AS ENUM ('author', 'curator', 'tester');

CREATE TABLE problem_members (
  problem_id bigint NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role       problem_role NOT NULL,
  PRIMARY KEY (problem_id, user_id, role)
);

CREATE TABLE problem_orgs (
  problem_id bigint NOT NULL REFERENCES problems(id)      ON DELETE CASCADE,
  org_id     bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (problem_id, org_id)
);
```

**The primary key includes `role` on purpose.** DMOJ's three separate
relations permit one person to be both an author and a curator of the same
problem. A `(problem_id, user_id)` key would collapse that pair into one row
and force the importer to choose. Including `role` keeps the import lossless.

### 2.3 Changes to existing tables

`problems` gains:

| Column | Type | Notes |
|---|---|---|
| `created_by` | `bigint NOT NULL REFERENCES users(id)` | Audit trail, distinct from authorship. The creator is *also* inserted as an `author`, but may later be removed from that list while this column stands. |

The existing `visibility` enum (`private | org | public`) is kept unchanged
and given its meaning here:

- `public` — visible to everyone, including anonymous callers.
- `org` — visible to members of any organization in `problem_orgs`.
- `private` — visible only to its own members and to admins.

That is a faithful three-state rendering of DMOJ's two booleans. No migration
of existing rows is required.

`problem_revisions` gains:

| Column | Type | Notes |
|---|---|---|
| `created_by` | `bigint NOT NULL REFERENCES users(id)` | Who attached this package. |
| `notes` | `text` | Free-form changelog, nullable. |
| `time_ms` | `integer NOT NULL` | Denormalised from the manifest. See §5. |
| `memory_kb` | `integer NOT NULL` | Denormalised from the manifest. |
| `test_count` | `integer NOT NULL` | Denormalised from the manifest. |
| `total_points` | `double precision NOT NULL` | Sum of `tests[].points`. |
| `checker_kind` | `text NOT NULL` | `standard` or `source`. |

and a constraint that does not exist today:

```sql
CREATE UNIQUE INDEX problem_revisions_version_idx
  ON problem_revisions (problem_id, version);
```

Version numbers are currently assigned by reading `max(version) + 1`, which
races: two concurrent attaches both read the same maximum and both insert.
The unique index converts that race from silent duplicate versions into a
constraint violation the service retries. **Add the index before relying on
the read-then-insert pattern, not after.**

### 2.4 The visibility predicate — one implementation

There is exactly one function answering "may this actor see this problem",
and every read path calls it. It lives in
`apps/api/src/authz/problem.visibility.ts` and is exported in two forms:

```ts
/** For list queries: a SQL predicate restricting `problems` to the visible set. */
export function visibleProblemsWhere(db: Db, actor: Actor | null): SQL;

/** For single-row reads and for the submission path. */
export function canViewProblem(
  actor: Actor | null,
  problem: { id: number; visibility: ProblemVisibility },
  ctx: ProblemViewContext,
): boolean;

export interface ProblemViewContext {
  /** The actor's roles on THIS problem. Empty for a non-member. */
  memberRoles: ProblemRole[];
  /** Organizations this problem is shared with. */
  sharedOrgIds: number[];
  /** Orgs the actor belongs to THAT THIS PROBLEM IS SHARED WITH — the
   *  intersection, not the actor's full membership list. */
  actorOrgIds: number[];
}
```

The SQL form takes `db` because it builds correlated subqueries over
`problem_members` and `problem_orgs`. The row form takes all three id sets
rather than a boolean, so the *decision* stays pure and testable without a
database while the *loading* is one shared helper,
`loadProblemContext(db, actor, problemId)`, that every single-problem path
calls — reads and writes alike. Authorization therefore never depends on
which handler the request arrived through.

Rules, deny-by-default:

| Actor | `public` | `org` | `private` |
|---|---|---|---|
| Admin | yes | yes | yes |
| Member of the problem (any role) | yes | yes | yes |
| Member of a shared org | yes | yes | no |
| Any other authenticated user | yes | no | no |
| Anonymous | yes | no | no |

Being an author, curator, or tester grants visibility **regardless of the
problem's visibility setting** — that is the entire point of the `tester`
role, which exists so a problem can be proofread before it goes public.

### 2.5 Edit rights

Separate from visibility, and not derived from it:

| Action | Permitted to |
|---|---|
| `POST /problems` | `globalRole` of `setter` or `admin` |
| `PATCH /problems/:code` | `author` or `curator` on that problem, or admin |
| `POST /problems/:code/revisions` | `author` or `curator`, or admin |
| `POST …/revisions/:version/publish` | `author` or `curator`, or admin |
| Everything else | read-only |

Testers can see a problem and submit to it. They cannot change it.

---

## 3. Global constraints

These bind every task in the implementation plan.

1. **One visibility predicate, two consumers.** `SubmissionAccessService.create`
   currently carries its own inline check
   (`apps/api/src/authz/submission.access.ts:31`, `visibility !== 'public'`).
   It must be replaced by a call to the shared predicate in the same commit
   that introduces it. A phase that enforces `org` visibility on the list
   endpoint but leaves the submit path alone produces a problem an org member
   can see and cannot submit to — which no unit test on either side would
   catch. This is the failure shape that has already cost this project three
   integration bugs across two phases.
2. **404 over 403 on reads.** A problem the actor may not see returns
   `problem_not_found`, never a distinct code and never a 403; the existence
   of a private problem is itself information. On *writes* against a problem
   the actor *can* see, 403 is correct — existence is already disclosed.
3. **`ProblemAccessService` is the only *service* importing guarded problem
   tables.** Same rule as `OrgAccessService` and `SubmissionAccessService`.
   `problem.visibility.ts` is not a service and is the one other file that
   holds these imports, by design — the predicate and the loader that feeds it
   belong together, and splitting them is how the two forms drift apart.
4. **Statements are Markdown.** Not HTML, not a rich-text blob. Forced by the
   deferred import: DMOJ stores Markdown with MathJax-delimited maths, and a
   different storage format would make that import lossy. Rendering is
   client-side and **must sanitize** — a `setter` is trusted to author
   problems, not trusted to run script in a reader's browser.
5. **No new hardcoded API prefix.** Every URL derives from
   `@duckoj/api-prefix`.
6. **Every new Dockerfile-visible workspace dependency updates the COPY
   manifest**, and `apps/api/test/dockerfile-manifest.spec.ts` must stay green.

---

## 4. HTTP surface

All routes sit under the existing `/api/v1` prefix.

### 4.1 Reads

```
GET /problems?q=&cursor=&limit=
```

Anonymous-allowed (`@Public()`), returns only what the caller may see. Keyset
pagination on `problems.id`; `limit` defaults to 50 and is capped at 100.
`q` matches case-insensitively against `code` and `name`.

```json
{
  "items": [
    { "code": "aplusb", "name": "A plus B", "visibility": "public",
      "timeMs": 1000, "memoryKb": 65536, "hasPublishedRevision": true }
  ],
  "nextCursor": "1042"
}
```

Limits come from the current published revision. A problem with no published
revision reports `null` limits and `hasPublishedRevision: false`; it still
appears in the list for those who may see it, because a setter must be able
to find the draft they are working on.

```
GET /problems/:code
```

Returns the problem plus its published revision's metadata:

```json
{
  "code": "aplusb", "name": "A plus B",
  "statement": "Read two integers…",
  "visibility": "public",
  "orgSlugs": [],
  "members": [{ "username": "alice", "role": "author" }],
  "currentRevision": {
    "version": 3, "timeMs": 1000, "memoryKb": 65536,
    "testCount": 12, "totalPoints": 100, "checkerKind": "standard",
    "publishedAt": "2026-08-20T00:00:00.000Z"
  }
}
```

404 `problem_not_found` if invisible. `members` is included for everyone who
can see the problem — authorship is credit, and DMOJ displays it publicly.

```
GET /problems/:code/revisions
```

Author, curator, tester, or admin only. Drafts are not public.

### 4.2 Writes

```
POST /problems                       201 -> { "code": "…" }
PATCH /problems/:code                200 -> the GET body
POST /problems/:code/revisions       201 -> { "version": 4 }
POST /problems/:code/revisions/:version/publish   200 -> { "version": 4 }
```

`POST /problems` body:

```json
{ "code": "aplusb", "name": "A plus B", "statement": "…",
  "visibility": "private", "orgSlugs": [] }
```

The creator is inserted as an `author` in the same transaction. Codes are
`^[a-z0-9][a-z0-9_-]{1,63}$`, unique case-insensitively (the existing
`problems_code_lower_idx`), and **immutable after creation** — a code appears
in URLs and is the identifier submissions were made against, so renaming it
breaks links for no product gain. `PATCH` rejects a `code` field outright
rather than silently ignoring it.

`PATCH` accepts any subset of `name`, `statement`, `visibility`, `orgSlugs`,
`members`. Setting `visibility: "org"` with an empty `orgSlugs` is rejected
(`problem_org_required`) — it would produce a problem nobody but its members
can see, which is what `private` already means.

`members` and `orgSlugs` are **whole-set replacements**, not deltas:

```json
{ "members": [{ "username": "alice", "role": "author" },
              { "username": "bob",   "role": "curator" }] }
```

A delta API needs add and remove verbs and a story for concurrent edits;
replacement needs neither, and the screen that will eventually drive it
(Phase 3) holds the whole list in memory anyway. Two rules guard it:

- The set must retain at least one `author` (`problem_last_author`, 400). A
  problem with no author has nobody who can edit it except an admin, which is
  a state the API should not be able to produce.
- A username that does not exist is `problem_member_unknown` (400), not a
  silent drop.

`POST …/revisions` body: `{ "packageHash": "…", "notes": "…" }`. Behaviour in
§5.

`POST …/publish` runs in one transaction:

1. Set every currently `published` revision of this problem to `archived`.
2. Set the target revision to `published`.
3. Set `problems.current_revision_id` to the target.

Archiving the previous revision is safe because `submissions.revision_id`
pins which revision graded each submission — the archived row stays
referenced and readable forever. Publishing a revision that is already
`archived` is allowed (it is a rollback); publishing one already `published`
is a no-op returning 200.

### 4.3 Error codes

| Code | Status | When |
|---|---|---|
| `problem_not_found` | 404 | No such code, or not visible |
| `problem_code_taken` | 409 | `POST /problems` with an existing code |
| `problem_code_immutable` | 400 | `PATCH` body contains `code` |
| `problem_org_required` | 400 | `visibility: "org"` with no orgs |
| `problem_forbidden` | 403 | Visible, but the actor may not edit |
| `package_not_found` | 404 | Attaching a hash with no stored package |
| `package_invalid` | 400 | Archive is not a well-formed problem package |
| `package_path_collision` | 400 | See §5.2 |
| `revision_not_found` | 404 | No such version for this problem |
| `problem_last_author` | 400 | A `members` replacement leaving no author |
| `problem_member_unknown` | 400 | A `members` entry naming no existing user |

---

## 5. Attaching a package

### 5.1 Denormalisation, and why it happens here

`packages` and `package_files` store the hash, the size, and the file list.
The **manifest is not in the database** — it lives inside the archive. So a
problem page that wants to show "1 second, 64 MB" would otherwise have to
fetch and unpack an archive on every view.

`POST /problems/:code/revisions` therefore:

1. Confirms the `packages` row exists (else `package_not_found`).
2. Reads the archive from the package store and unpacks it in memory.
3. `parseManifest` on `manifest.json` (else `package_invalid`).
4. Runs the path-collision check of §5.2 (else `package_path_collision`).
5. Inserts the revision with `time_ms`, `memory_kb`, `test_count`,
   `total_points`, and `checker_kind` copied from the manifest.

Step 3 is worth as much as the denormalisation itself: it moves "is this
archive actually a problem?" from *first submission* — where it surfaces as a
judge-side internal error against a real user's code — to *attach time*,
where it surfaces as a 400 to the person who caused it.

### 5.2 Path collisions

Carried from the Phase 2a ledger (Task 2's carried finding, recorded as
belonging to "upload or the materialiser"). `packageHash` deliberately does
**not** case-fold: `README.md` and `readme.md` are distinct content. The
hazard is downstream — a judge materialising both onto a case-insensitive
filesystem (default macOS, Windows) has the second write clobber the first,
after which re-hashing the materialised directory disagrees with the stored
hash.

Attach time is the right gate: it is the last point before a package becomes
gradeable, and rejecting there never changes an existing hash. Reject when
two paths in the manifest's package collide under
`toLowerCase()` **or** under Unicode NFC normalisation.

---

## 6. Granting the `setter` role

`Actor.globalRole` already has `'user' | 'setter' | 'admin'`, and nothing in
the system sets it to `setter`. Without a grant path, `POST /problems` cannot
be exercised end-to-end against a real stack — which is precisely the class
of gap that has produced every integration bug in this project so far.

The minimum honest fix, and all this phase builds:

```
PATCH /admin/users/:username   { "globalRole": "setter" }   -> 200
```

Admin-only. No user-listing endpoint, no user admin UI — those belong with
Phase 3. The runbook gains the equivalent SQL for bootstrapping the first
admin, which necessarily predates any admin being able to call this.

---

## 7. Web surface

| Route | Who | Contents |
|---|---|---|
| `/problems` | anyone | Searchable list, keyset "load more" |
| `/problems/:code` | anyone who may see it | Rendered statement, limits, submit link |
| `/problems/new` | setter, admin | Create form |
| `/problems/:code/edit` | author, curator, admin | Edit form; visibility and orgs |
| `/problems/:code/revisions` | author, curator, tester, admin | Revision list; attach by hash; publish |

Statement rendering uses `marked` for Markdown, `katex` for maths, and
`dompurify` to sanitize the result before it reaches `dangerouslySetInnerHTML`.
Three dependencies, all with no native build step.

**Sanitize even though setters are trusted.** The trust boundary that matters
is not "do we believe this setter" but "can a compromised or careless setter
account run script in every reader's session". The answer must be no.

Package *upload* remains `scripts/package-build.ts` plus the existing
`POST /packages`. The revision screen takes a hash, not a file — a drag-and-drop
uploader is Phase 3 work and nothing here blocks on it.

---

## 8. Testing

Beyond the per-task tests the plan specifies:

1. **The visibility matrix.** Every cell of the §2.4 table, as data-driven
   cases against a real database. Three visibilities × five actor kinds.
2. **The cross-service test, named as such.** An org member submits to an
   `org`-visible problem and receives 201. This exists specifically to fail if
   someone reintroduces a second visibility implementation in the submission
   path.
3. **The migration runs against real PostgreSQL 16** before any task depends
   on it. `ALTER TYPE … ADD VALUE` has transaction-boundary rules that differ
   from ordinary DDL, and `drizzle-kit` may generate a drop-and-recreate
   instead; see §10.
4. **End-to-end against the live stack:** create a problem, attach a package,
   publish it, submit to it, and read back `AC`. Run via
   `scripts/compose-up.sh` as in Phase 2a, not against mocks. The three
   integration bugs of Phase 2a were each invisible to a green unit suite and
   visible immediately here.
5. **Every new test must be shown to fail** against the unfixed code or a
   deliberately broken variant. Phase 2a shipped three tests that could not
   fail and were caught only in review.

---

## 9. Carried debt

### Fixed in this phase

| Item | Why here |
|---|---|
| A compile error reports as verdict `IE` because `case_verdict` has no `CE` member | This phase already migrates the enum; and a setter publishing a problem is the person most likely to submit code that fails to compile |
| `packages/contracts/src/registry.ts:9` hardcodes `/api/v1` outside `API_PREFIX` | One line, and this phase adds contracts to that registry |
| Case-insensitive / NFC path collisions unvalidated | §5.2 — this phase builds the attach path where the check belongs |

### Deliberately not fixed

| Item | Ruling |
|---|---|
| No scheduling policy, priority, or attempt cap | Phase 4, with the rest of scheduling. Fixing it piecemeal here means designing a policy twice. |
| `apps/judged`'s three-sighting flake | Still unreproduced and unexplained. A speculative fix destroys the only evidence. Stays quarantined and watched. |
| The `COPY . .` stale-image trap in the `migrate`/`api` image | Real, but it is a build-tooling change with its own blast radius, and the runbook documents the symptom. Not mixed into a data-model phase. |
| Hand-maintained Dockerfile COPY manifests | `dockerfile-manifest.spec.ts` now *detects* a missing entry, which was the actual failure. Generating them is a separate change. |
| `Materializer.ensure()` coalescing unpinned by tests | Correct by experiment, untouched by this phase. |
| The `sizeBytes` drift window on a crashed upload | Needs a crash mid-transaction plus a recompression. Unchanged by this phase. |

---

## 10. Risks

**`ALTER TYPE case_verdict ADD VALUE 'CE'`.** PostgreSQL permits this inside a
transaction since 12, but the new value is unusable until that transaction
commits — and `drizzle-kit` sometimes emits a drop-and-recreate for enum
changes instead, which fails outright against a column already using the type.
The first task of the plan generates this migration and runs it against real
PostgreSQL 16 before anything depends on it. If drizzle emits the wrong shape,
hand-write the SQL: this is a case where the generated artifact must be read,
not trusted.

**Version assignment races.** Covered by the unique index of §2.3, but the
service must handle the constraint violation by retrying rather than
surfacing a 500.

**Statement size.** Nothing here bounds statement length, and `text` accepts a
gigabyte. Cap it at 256 KiB in the Zod contract — comfortably above any real
problem statement and far below anything that hurts.

**Scope drift toward Phase 3.** Member management has an API here and no UI.
The temptation will be to build the screen "since the endpoint exists". It
belongs with organization management, where the user-picker it needs is also
being built.

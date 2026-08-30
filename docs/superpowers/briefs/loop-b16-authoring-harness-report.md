# B-16 — publishedVersion, F-18 drafts, harness realism, forced-change UX

Branch `worktree-agent-a8ce4ffaa80de9413`, not pushed. **DONE_WITH_CONCERNS.** Ritual green
(typecheck ×2, lint ×2, `-r test`: api **989**, web **496**; regen no diff; `vite build`);
every finding below is red→green with its own mutation check.

1. **~900 API specs never ran the production wiring** — high · `2e9a26c` (D91). `buildApp`
   hand-applied `cookieParser` + `ProblemFilter` and nothing else: the whole suite ran
   **unprefixed, with no CORS, no body limits, no keep-alive**. It now calls `configureApp`,
   the function `main.ts` calls. 867 spec call sites prefixed mechanically across 68 files;
   `/healthz`, `/readyz`, `app.smoke`'s two off-the-prefix negatives and seven bare-module
   guard specs excluded. `harness-realism.spec.ts` guards it (prefix · exposed headers · 413 ·
   `x-powered-by` · keep-alive). **Nothing else broke** — the 3 failures were my own codemod.
2. **`LOG_LEVEL=silent` crashed the API at boot** — medium · `2e9a26c` (D91). One of pino's
   own levels, the only one `EnvSchema` omitted, so a quiet container was a boot loop. Found
   because `TEST_CONFIG` set it — a config `loadConfig` would have refused (`port: 0` too).
3. **F-21's `publishedVersion: null` is a phantom** — info/process · `5e4caf3` (D92). The
   field never existed in any contract; `jq` prints `null` for a missing key, so the
   projection "found" a bug in a key nobody had declared. Reproduced on live and by grep.
4. **…but the detail could not say WHICH revision is live** — medium · `5e4caf3` (D92). Only
   `hasPublishedRevision`; the number sat behind `/problems/{code}/revisions`, members-and-
   admins only. `publishedVersion: number | null` added to `ProblemDetail` in **both**
   builders (`getVisible`, `loadDetailById`), nulling with the four other revision-derived
   fields — incl. the archived-pointer case `problem-reads.spec.ts` said no fixture could
   build. Dropping the join's `state = 'published'` reds it.
5. **A draft's caps are read-modify-write, so two PUTs blow through them** — medium ·
   `4b38ebb` (D93). Measured: two concurrent PUTs at the 499-file boundary both answer 200
   and leave **501** files; same at 512 MiB. The tab uploads serially, which is why nothing
   noticed; four workers share the volume. Fixed with a `.lock` dir beside `meta.json` (atomic
   `mkdir`, cross-worker, 2-min stale takeover) held across the cap decision and
   `buildPackage`. No lock → both races red; no takeover → the draft freezes for 24 h.
6. **The sweeper deleted a draft out from under an in-progress build** — medium · `bc5d6db`
   (D93). `sweep` → `rm -r`, lock and all: a draft crossing its 24 h mid-build was yanked and
   the setter got a raw `ENOENT` verbatim in a 422. Now skipped (not waited on) while held
   and fresh, reclaimed once the lock is stale.
7. **The forced-password-change confirmation was unreadable** — low · `79665bb` (B-14's open
   concern). The `me` refetch that clears `mustChangePassword` unmounts the page carrying
   `password.done` in the same tick it becomes true. It now belongs to `PasswordGate`, which
   outlives the swap, as a dismissible `role="status"`.

**Verified safe** (`4b8fd5a`): `..%2F`, `%00`, spaces, `.`/`..` and now **unicode** names
refused before a byte lands · a **curator** may author, a **tester** on the same problem may
not (403, mutation-killed) · an identical-hash build attaches a NEW revision (ruling, D93) ·
nothing in this API deletes a problem, so a draft on a deleted problem has no case.

**Live probe** — `apps/web/e2e/authoring.spec.ts`, 3 journeys green (`4b8fd5a`). duckadmin
creates `bh16-ab-<RUN>` at `/problems/new`, types **two tests** + a standard checker into
"Dữ liệu chấm", publishes → `Đã tạo và công bố phiên bản 1.`; D88's load-from-revision round
trip; one `bh16-*` pupil submits the model solution → **AC**. Zero console errors and zero
broken subresources; confirmed out of band as public, 2 tests, 1000 ms / 65536 KB.

## Concerns
1. A draft held past the 30 s lock wait throws a plain `Error` → **500**, not a 409;
   unreachable in practice, still the wrong status.
2. A PUT between `buildPackage` and `drafts.delete` is lost with the draft — unchanged from
   D87; the lock covers the tar, not the whole build.
3. The live stack runs `main`: `publishedVersion` is absent and the cap race live until it
   is redeployed.
4. `getVisible`/`loadDetailById` are near-duplicate builders (every field added twice), and
   the codemod would miss a spec building its path in a *variable* — none does today.

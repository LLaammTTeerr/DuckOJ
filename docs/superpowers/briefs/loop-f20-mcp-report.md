# F20 — `apps/mcp`: a Model Context Protocol server for DuckOJ

`@duckoj/mcp`, stdio, on `@modelcontextprotocol/sdk` 1.30 + zod 4, one access token. **19 tools**
— 12 read (`problems_search/get/stats/editorial`, `submissions_list/get/watch`, `contests_list/
get/scoreboard/clarifications`, `me_progress`), 7 write (`submissions_submit`, `contests_ask`,
`contests_announce`, `problems_patch`, `problems_draft_create/put_file/build`). **4 resources**
(`duckoj://problems/{code}/statement`, `…/contests/{key}/scoreboard`, plus `duckoj://tags` and
`duckoj://languages`, the vocabularies tools take arguments from) and **2 prompts**
(`solve-problem`, `prepare-problem`). `oj mcp` starts it with the CLI's credential. Files:
`apps/mcp/**` (12 src, 7 test, `scripts/e2e.ts`), `apps/oj/{package.json,tsconfig,src/main}`,
`docs/guide/mcp.md` (vi + en), `docs/DECISIONS.md` **D89**, lockfile.

## Rulings (argued in D89)
1. Writes off unless `DUCKOJ_MCP_WRITES=1` (`=== '1'` exactly); a withheld tool is **never
   registered** — absent from `tools/list`, not refused at call time.
2. "Write" = scope ends `:write`/`:publish`, so `submissions_submit` is gated too: it enqueues a
   container, D80 meters it, a contest submission is irreversible.
3. No admin tools, no switch for them — `/admin` is `@SessionOnly`, a bearer token gets 403 (D50).
4. **Underscored** names, not the brief's dots: a host composes `mcp__<server>__<tool>` and the
   Anthropic name rule is `^[a-zA-Z0-9_-]+$`. `TOOL_NAME_PATTERN` refuses a dot at construction.
5. `problems.list`/`search` is ONE tool; no arguments = the plain list. `submissions_watch`
   answers `timedOut:true` instead of failing (hosts cancel long calls); 401/403/404 fail at once.
6. Samples parsed out of the statement (the API models none) as `samples:{source,items}`, where
   `source:'none'` means "read the statement", not "no samples".
7. Credential is `oj`'s; its ~25-line reader is duplicated because `oj`→`mcp` would be a cycle.
   A bare origin gains `/api/v1` — else the SDK asks Caddy for `/problems` and gets the SPA, 200.
8. `prepare-problem` describes the CLI/draft flow (no `packages/prepare` here); no fourth `/help` tab.

## Tests — 74 in `apps/mcp`; ten mutations, each restored green after
`selectTools` ignores the switch → 3 fail · `writesEnabled` truthy not `==='1'` → 1 ·
`normalizeBaseUrl` drops `/api/v1` → 2 · `Retry-After` not read → 2 · draft `put_file` sends JSON
→ 1 · watch never stops on a terminal state → 3 · watch retries a 404 like a blip → 2 · samples
takes any 2-column table → 1 · search sends `tags` not `tag` → 1 · empty `problems_patch` → 1.
Tools run through the real `createClient` over a doubled `fetch`, so a wrong path or body fails;
the gate is asserted through a real `McpClient` on the SDK's in-memory transport — the claim is
what a HOST sees, not what a filter returns.

## `corepack pnpm --filter @duckoj/mcp e2e`, live stack
```
1..3 registered mcp-e2e-b0a6b84c, signed in, minted problems:read submissions:read/write
     languages:read (Origin per D82; /auth/tokens is session-only, D50)
4.   connected — 19 tools: problems_search, problems_get, … problems_draft_build
5.   problems_search -> 5 problem(s) — more available, pass `cursor`; problems_get ->
     tong-hai-so — Tổng hai số (1000 ms limit, 2 sample(s)), statement 1443 chars, 2 samples
     parsed; resource duckoj://problems/tong-hai-so/statement -> # tong-hai-so
6.   corepack pnpm --silent --filter @duckoj/mcp start -> handshake ok, 12 tools, no write tool
7.   submissions_submit -> submitted #340; submissions_watch -> #340 tong-hai-so: AC 100/100
     · cases 12 ({"AC":12}) after 2 polls
PASS — read, submit and watch all round-tripped against the live stack.
```

`pnpm -r typecheck`, `typecheck:scripts`, `pnpm -r lint`, `lint:scripts`, regen (**no diff**),
`vite build` — green; `apps/oj` 28/28, `apps/mcp` 74/74. `oj mcp` smoked by hand off a written
`config.json`: banner on stderr, 12 tools, stdout pure JSON-RPC; with no credential it exits 1
with the `oj login` hint. Concerns: **two pre-existing flakes under full-suite load**, unrelated
(nothing here is imported by `apps/api`/`apps/web`) — one of `apps/web/test/{submit,logout}`
and `apps/api/test/contest-booklet.spec.ts`; each passes run alone (jsdom/PG). `--silent` is
load-bearing in the pnpm launch line (its banner goes to stdout, the MCP wire) — step 6 pins it.
The samples extractor knows one table shape; another returns `none`, honest but silent — the real
fix is a `samples` field in the API. The SDK pulls express/hono/jose transitively (+14 packages).

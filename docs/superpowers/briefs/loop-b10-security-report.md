# Loop B10 — security hunt

**DONE_WITH_CONCERNS.** 12 findings: 4 fixed (4 commits), 8 cleared with evidence. Rulings **D69**,
**D70**. **No blockers.** Ritual: typecheck, lint, scripts, contracts/SDK regen (no drift) and
`vite build` all green; api 759/760, web 339/340, with the odd one out rotating between runs and
passing in isolation — pre-existing load flakes in files this branch does not touch (see Concerns).

## Fixed

**1. No security response headers at all — MEDIUM (D69).** Live stack served no CSP, HSTS,
`X-Content-Type-Options`, `Referrer-Policy` or `X-Frame-Options`. The SPA's `index.html` runs
author-controlled statement HTML via `dangerouslySetInnerHTML` and Caddy's `file_server` serves it
without touching Node, so the headers must be set at the edge or they miss it. Added those four plus
an SPA-scoped CSP: `script-src 'self'` with **no** `'unsafe-inline'` (the Vite build emits no inline
scripts), `style-src` **with** it because KaTeX writes an inline `style` on every formula, plus
`object-src 'none'`/`base-uri 'self'`/`frame-ancestors 'none'`/`form-action 'self'`. Verified against
a throwaway `caddy:2-alpine` on the real file — all five present, CSP byte for byte. Mutation red→green.

**2. Typst code injection via a statement's fenced block — MEDIUM.** `rawBlock` hard-coded a
four-backtick fence ("covers every fence the Markdown could open" — true of what *opens* a fence,
false of what sits *inside* one). Four backticks mid-line closed the raw literal and the rest reached
`typst compile` as **code**: proven against the real binary, an injected `#read(...)` was evaluated.
Blast radius measured — typst confines reads to the project root (`../` refused), so reach is `/app`;
the package store and its secret test data at `/var/lib/duckoj/packages` are **not** reachable. Hence
MEDIUM — but D48 compiles a contest's every problem into one document, so one poisoned statement is the
whole booklet on contest day. Fixed with CommonMark's rule (fence longer than the longest run, floor of
four). Two cases in `statement-pdf.spec.ts` shown red first; payload now compiles as literal text.

**3. No Origin check on the WebSocket upgrade — MEDIUM (D70).** The gateway authenticates browsers by
session cookie and a `new WebSocket()` from a hostile page is not subject to CORS; `SameSite=Lax` was
the only control. A wrong `Origin` is now 403; a **missing** one is allowed deliberately — the `oj` CLI,
judge agent and tests set none, carry no ambient cookie, and use a header a hostile page cannot set.
`realtime.spec.ts`, mutation red→green, 17/17.

**4. `X-Powered-By: Express` — LOW.** Off at the source and stripped at the edge, so neither half is
load-bearing alone. Mutation red→green.

## Cleared with evidence

- **Cookie flags** — live: `HttpOnly; Secure; SameSite=Lax; Path=/`. **CORS** — `Origin:
  https://evil.example` still gets the configured origin back; fixed, not reflected.
- **Mass assignment** — `PATCH /users/me` with `globalRole:"admin"` → `422 Unrecognized key`
  (`.strict()`), role unchanged. **IDOR** — a plain user PATCHing `/admin/users/duckadmin` → `403
  admin_forbidden`.
- **Admin/credential routes via bearer token** — `PATCH /admin/users/{u}`, `POST /auth/tokens`,
  `POST /auth/totp/begin` all `403 session_required`, ahead of the admin check, so no existence leak.
- **Login timing oracle** — dummy argon2id burned for unknown accounts; 32–43 ms known-wrong vs
  30–33 ms unknown. OWASP argon2id (19 MiB/t=2/p=1), shared with the bootstrap script so it cannot drift.
- **Error responses** — problem+json only; no stack, driver text or SQL across `/submissions/NaN`, huge
  ids, encoded traversal, quote injection, bad body. **Path traversal** — refused twice: manifest Zod
  schema, again at unpack.
- **`pnpm audit --prod`** — one moderate, `fast-xml-parser@4.5.7` (GHSA-gh4j-gqv2-49f6). **No exploit
  path**: advisory is `XMLBuilder`-only, `polygon-import` imports only `XMLParser`; no DTD/entity
  processing, so no XXE.

## Concerns

- **CSRF is cleared but single-layer.** Lax withholds the cookie from every cross-site unsafe method
  and all state changes are unsafe methods, so its top-level-GET allowance grants nothing — but there
  is no Origin check on HTTP routes and no token. Two-layer needs every controller: its own brief.
- **The typst subprocess has no timeout or output cap.** The injection that made a hang trivially
  reachable is closed; the missing bound is not.
- **`clientIp` trusts the leftmost `X-Forwarded-For`** — correct for Caddy today and noted in the
  runbook; a second proxy layer makes D16/D26 bypassable.
- **Two flaky suites, not mine.** `apps/web` (`logout`, `contest-new`, `settings`) and
  `apps/api/test/contest-scoreboard-cache` fail only under parallel load and pass alone; the failing
  set rotates run to run. This branch changes no `apps/web` or scoreboard file, so they run unmodified
  code. Worth a real fix (fake timers / `findBy` budgets) in a later brief.
- Left on the live stack: throwaway user `bh10probe1` (plain, no content); its token was revoked.

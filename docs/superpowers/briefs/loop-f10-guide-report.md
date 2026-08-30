# F10 — user guides (hoc-sinh / giao-vien / quan-tri) + in-app `/help`

Status: **DONE_WITH_CONCERNS**. One commit, no migration, no contract change.
Web gate green: typecheck, lint, **350 tests / 38 files**, `vite build`.

## Shipped
`docs/guide/hoc-sinh.md` (12 mục), `giao-vien.md` (11), `quan-tri.md` (10) —
Vietnamese first, English after a top-level `## English` (D10's "both locales
are real", D48's marker). Every claim checked against the route files and
`i18n/vi.ts`, using the shipped labels verbatim (*Nộp bài giải*, *Đưa lại vào
hàng đợi*, *Hủy tư cách …*).
`apps/web/src/routes/help.tsx` — `/help`: the guides imported with Vite `?raw`
(ONE copy: site and repo cannot drift), rendered through the existing
`renderStatement` (markdown + KaTeX + DOMPurify last), tabbed by role with
`aria-pressed` on the LocaleToggle pattern. Both halves always render, the
reader's own locale first (D18). No API call, no `<Link>` — readable signed
out. `router.tsx`: one import, one route, one `addChildren` entry, one ungated
nav link beside **API** (no footer exists). `i18n/{en,vi}.ts`: 7 appended keys.
## Tests — `apps/web/test/help.spec.tsx` (10), five mutants, five killed
Locale ordering dropped → English-first red · `renderStatement` → raw source →
3 red (HTML, ordering, single-`<h1>`) · split regex unanchored → sentence case
red · `active` ignored → 2 red · `aria-pressed` dropped → tab case red. Each
restored, green after.
## Rulings (nobody to ask; no D-number — DECISIONS.md was outside my scope)
1. **No homework entity exists** — documented as its two substitutes: a
   long-window contest restricted to the school org, or a filtered `/problems`
   URL. 2. **No scoreboard export exists** — print the page (`@media print`
   already drops the nav), copy the real `<table>` into a spreadsheet, or `GET
   /contests/{key}/scoreboard` with a read-scoped token. 3. **"Giáo viên" is
   not a role** — the guide opens with the three real things it decomposes
   into (global `setter`, org **owner**, contest creator) and says creating an
   org and rejudging stay admin-only.

## Concerns
1. A guide edit reaches the site only on a rebuild (bundled at build time);
   bundle 962 kB → 1,025 kB. 2. **`admin.totpNote` (vi+en) is stale since
   D39** — still claims there are no recovery codes; the guide says the right
   thing and flags it, the string is unfixed (i18n scope was append-only).
   3. `problem.editorialShow` is an orphan key. 4. No Playwright journey for
   `/help`, and nothing ties a guide sentence to the screen it describes.

# B11 — the newest features reviewed (F8/F9/F11/F12/F13; D61·D66·D68·D71·D72)

Seven defects: failing test first, fix, mutant red and restored, one commit each
(plus a lint rider). **D73**, **D74** new; **D75 unspent**; no migration.
## Majors
**1. A headerless roster loses a pupil at every chunk boundary. f652101**
`splitImportCsv` emitted headerless chunks bare while the server detects a header
PER REQUEST, so whichever record opens a chunk decides that chunk's columns.
`user`, `taikhoan`, `tendangnhap` are valid usernames (D8) *and* header aliases,
so that pupil is eaten as chunk two's header (201, sheet one short of the class,
nothing says so) — or, if the alias sits in another column, the whole chunk is
re-read wrongly. Every chunk states `username,displayName,email` now.
**2. The credential sheet ran a stranger's formula. 3d4b859** D71 states the rule
— BOM, CRLF, apostrophe guard on person-typed cells — and implemented it for
`results.csv` alone. `credentialsCsv` did RFC 4180 and nothing else: a roster
display name of `=HYPERLINK("http://evil","A")` executes when the importer opens
the file, a leading `-` in a username is a formula too, and with no BOM every
Vietnamese name is mojibake. The rules live once now, beside D61's grammar.
**3. The homework export, same hole, sharper. 9d62a50** `progressCsv`: no BOM, LF,
no guard — and its person-typed column is the display name of the pupil being
exported, chosen by them, read by their teacher.
**4. A stolen session was an unlimited password oracle (D73). 4ca5430** D72
demanded the password on `DELETE /auth/totp` and `POST /auth/password/change`
because "a session is the thing an intruder steals" — then left the check that
reads it unmetered: 401 wrong, 2xx right, no email, no 2FA, no fresh sign-in,
while `login` has been metered since B1 so that door is shut. Ten per account per
15 min, ONE budget over both routes, read before the hash — D72's own shape; also
a DoS, each check being a 19 MiB argon2id on the pool every sign-in shares.
`mustChangePassword` accounts never spend it.

## Mediums
**5. 693261c** The merged credential sheet carried one header per REQUEST, at rows
502 and 1,003 of a 1,200-row import, where Excel reads them as pupils. Built once
from the merged rows now; the textarea drops the BOM (a selection is not a file).
**6. `top=N` cut through a tie (D74). 560f8a6** The board ranks in competition
style; `slice(0, top)` gave one of two equal thirds a certificate and the other
nothing, on a tiebreaker no printed result names. The boundary is a RANK now —
`top=3` over 1, 2, 3, 3 is four sheets.
**7. A display name defaced its own certificate. ec217c7** `escapeText` covered
mid-line markup and none of `= `, `+ `, `/ `, `1. `, which typst reads only at a
line start — and `DisplayName.trim()` is ends-only, so `typst query heading`
returned the injected text, on the certificate and in the standings sheet. Line
breaks become spaces now; a first-position marker is escaped (only there, so
`GMT+7` reads as itself). Not evaluation: `#` was always escaped. **16364cc** and
**0636eee** ride on 5 and 2 (a raw U+FEFF in source; the CLI sheet's own test).

## Rulings, and what was left over
D73/D74 are in `DECISIONS.md` and the OpenAPI descriptions. 2, 3 and 5 extend
**D71's** CSV rule to exports that always fell under it rather than spending D75 —
F13's amend-in-place precedent. Recorded, not fixed: **cross-chunk duplicate
EMAILS** (the panel dedupes usernames only, so two chunks naming one address
strand a half-created sequence — F13's shape, one field short); and a revoked judge
keeps its socket (handshake-only verification; its package fetches 401, so the work
fails rather than completing).

## Verification
Per-package, sequential (prior reports document flakes under `-r test` contention):
**api 852/852 (97 files), web 398/398 (41), db 48, judged 118, contracts 36**, every
other package green; typecheck and lint incl. `:scripts`; regen leaves no diff;
`vite build` OK. Live stack never stopped, nothing pushed.

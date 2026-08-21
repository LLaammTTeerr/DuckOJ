# Phase 3b — Surfaces: design

**Status:** approved for implementation.
**Predecessors:** `2026-08-21-phase-3a-foundations-design.md`,
`2026-08-21-api-completeness-note.md` (binding), `docs/design/mockup-v1.html` (approved).

---

## 1. What this phase is

Phase 3a made scopes real and adopted a router. This phase makes the product
usable: the API gains the routes an agent or a screen actually needs, and the
web app gets the approved retro-terminal design.

Two streams, deliberately disjoint so they can run in parallel:

- **A — API completeness.** The gaps named in the API-completeness note.
- **B — The design.** `docs/design/mockup-v1.html`, implemented.

The ordering rule from the API note holds: **a screen may only consume routes
that already exist.** Stream B does not invent endpoints.

### Out of scope

Organization *management* screens (org CRUD API lands here; the screens do
not) · tags · contests · problem deletion · scheduling policy · an MCP server
itself · browser package upload.

---

## 2. Stream A — API completeness

### 2.1 `GET /languages` — the sharpest gap

`POST /submissions` takes a `languageKey` and rejects unknown ones. Nothing
lists the valid keys. A caller that has not read `scripts/seed-problem.ts`
cannot submit at all, which makes the whole submit path unusable to an agent
and to any client that is not this repo's own web app.

```
GET /languages          @Public()  @RequireScope('languages:read')
-> { items: [ { key, name, extension, isActive } ] }
```

Inactive languages are **included, flagged**, not hidden. A submission made
last year against a now-inactive language must still render its language name;
a list that omits it forces every consumer to handle a dangling key.

Adds `languages:read` to the scope vocabulary — the first scope added since
3a, and the test that pins the vocabulary must be updated deliberately rather
than by regenerating a snapshot.

### 2.2 `GET /submissions` — an agent cannot enumerate its own work

`GET /submissions/:id` exists; nothing produces ids. Keyset pagination on
`submissions.id`, newest first, following `listVisible`'s established shape.

```
GET /submissions?problem=&user=&verdict=&cursor=&limit=
    @RequireScope('submissions:read')
```

**Visibility is the whole risk here.** `SubmissionAccessService.getVisible`
already answers "yours or admin", and this list must produce exactly the set
that `getVisible` would allow one by one — no more. The failure mode is a list
endpoint that is laxer than the single-item read, which is the same
green-suite-broken-integration shape as Phase 2b's org-visibility bug, and it
must be tested as one property rather than two.

A `user=` filter naming somebody else returns an empty page for a non-admin —
not a 403, which would confirm the user exists.

### 2.3 `GET /orgs/:slug/members` and org write routes

Organizations have a full permission model and no way to manage them over
HTTP. Minimum viable set:

```
POST  /orgs                    @RequireScope('orgs:write')   admin only
PATCH /orgs/:slug              @RequireScope('orgs:write')   owner/admin of that org
GET   /orgs/:slug/members      @RequireScope('orgs:read')    visible-to-caller only
```

Membership *mutation* (invite, approve, remove) is deliberately excluded: it
needs the join-request state machine that `org_join_requests` already models,
and half-implementing that is worse than not starting.

`orgs:write` is the second new scope.

---

## 3. Stream B — the design

`docs/design/mockup-v1.html` is the approved reference. Two rules from it are
structural, not cosmetic, and must survive implementation:

**Colour is reserved for verdicts.** Chrome is monochrome. A green- or
amber-phosphor chrome collides with AC-green and TLE-amber, and on a judge the
verdict must read before anything else. Every verdict carries a **glyph as
well as a hue** — never colour alone, so it survives colour-blindness and a
monochrome screenshot.

**The statement is the only non-dense surface.** 68ch measure, 1.7
line-height. Everything else is a table meant for scanning.

### 3.1 Mechanism: plain CSS on semantic elements, unchanged

The app currently has **one** `className` in 1,200 lines of TSX and 227 lines
of CSS. That is why restyling is cheap, and it is worth preserving: a retro
terminal is mostly borders and monospace, which is what utility classes buy
least on.

Components may gain a class where a rule genuinely cannot be expressed on an
element — the verdict glyph and the case grid will need them. Adding a class
per element is not.

### 3.2 The font

IBM Plex Mono, **self-hosted**, not from Google's CDN. The compose stack has
no guaranteed outbound network — the same reason Task 7b vendored the Scalar
bundle — and a webfont that silently fails to load falls back to a system
monospace whose Vietnamese diacritics may be unstyled or absent.

Subset to `latin` + `latin-ext` + `vietnamese`. Weights 400 and 600 only.
Nerd Font icons are **out of scope for this phase**: the mockup's ASCII
placeholders stay, because choosing an icon set is a separate decision and a
patched font is 2–8 MB unsubsetted.

### 3.3 Screens

| Screen | State |
|---|---|
| Problem list | Restyle; add the `me` verdict column, which needs 2.2 |
| Problem detail | Restyle; statement pane at 68ch |
| Submit | Restyle; **add the case grid**, which needs data already on `SubmissionDetailDto` |
| Revisions | Restyle; truncate hashes head…tail |
| Home, login, edit | Restyle only |
| Submissions list | **New**, consuming 2.2 |

---

## 4. Testing

1. **The list/read agreement property.** For a fixed corpus of submissions and
   a fixed actor, the set returned by `GET /submissions` must equal the set of
   ids for which `GET /submissions/:id` returns 200. Asserted as one test over
   both paths, not two tests that could drift.
2. **The scope vocabulary test must be updated by hand** when `languages:read`
   and `orgs:write` are added — never by regenerating a snapshot, which would
   accept any change including a deletion.
3. **Playwright must still pass**, and gains coverage for the case grid and
   the submissions list.
4. **Every new test demonstrated to fail** against unfixed code.
5. **The font must be proven to load offline** — the stack has no guaranteed
   outbound network, so a test or a documented check must show the served page
   does not reach `fonts.googleapis.com`.

---

## 5. Risks

**The submissions list is a visibility surface.** Every other risk in this
phase is cosmetic; this one leaks other users' submissions if the list's
predicate is laxer than the single-item read. §4.1 exists for it.

**Self-hosting the font is easy to half-do.** A `@font-face` that still falls
back to a CDN, or a subset missing `vietnamese`, both look fine on a developer
machine with the font cached and fail on a fresh client.

**Restyling touches every screen at once.** Mitigated by Playwright, which
tests behaviour rather than appearance — but note that means it will **not**
catch a visual regression, and nobody has ever looked at these pages except
through a browser once. A screenshot pass is the honest check.

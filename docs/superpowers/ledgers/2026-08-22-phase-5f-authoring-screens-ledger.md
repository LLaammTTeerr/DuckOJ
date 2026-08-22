# Phase 5f — authoring & credential screens: ledger

**Trigger:** the user, looking at the running app: "webpage fe is still
not finish and no polygon yet?" An FE-vs-API audit
(`grep api.POST|PATCH` across the web routes) found four surfaces with
API but no UI. All four closed:

- **`/contests/new`** — the loudest gap: contests could not be created
  from the browser at all. Key/name/window/format/visibility + problem
  rows. `datetime-local` values are converted to instants
  (`toISOString`) before sending — a setter thinking in ICT while the
  server stores UTC is how a contest starts seven hours early; a
  mutation sending the zoneless string fails a test.
- **Package upload** on the revisions screen — file + the hash
  `package:build` printed (the hash is over unpacked file digests,
  which a browser cannot cheaply recompute; the server verifies it
  anyway). Success prefills the attach field: upload → attach is two
  clicks. This also completes the **Polygon story in the web**:
  `polygon:import` → `package:build` → browser upload → attach.
- **`/account/tokens`** — mint/revoke the tokens the `oj` CLI needs;
  the plaintext shows once with a copy-now warning. Scope checkboxes
  come from the contract's `SCOPES` export (web now depends on
  `@duckoj/contracts`, which is browser-safe by its own doc comment) —
  a hand-copied list was in the first draft and was replaced, with a
  test iterating the real vocabulary so it cannot drift.
- **Org creation** on `/orgs` for admins (API is admin-only; the form
  is hidden from everyone else).

Plus nav (`Tokens`) and a `New contest` entry point for setter/admin.

## Mutation evidence (isolated, restored green after each)

| Mutation | Result |
| --- | --- |
| zoneless startTime sent raw | 1 fail |
| blank problem rows sent | 1 fail |
| upload success does not prefill attach | 1 fail |
| create-org form shown to non-admins | 1 fail |

## Note on "no polygon yet"

Polygon import deliberately has no server-side zip endpoint (7a R1:
zip-slip/bomb surface). The web-visible flow is the upload above; the
parse itself stays a CLI. If a one-click polygon-zip upload is wanted
anyway, that ruling is the thing to reverse — knowingly.

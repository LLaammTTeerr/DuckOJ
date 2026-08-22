# Phase 5d — organization screens: ledger

## What shipped

- `apps/web/src/routes/orgs.tsx` — list and detail. The detail derives
  the viewer's standing from their row in the members list (one query;
  the roster and the viewer's role cannot disagree), and branches:
  stranger → Join/Request (never on invite-only), member → Leave,
  owner/admin → requests queue, role selects, Remove.
- Routes `/orgs` and `/orgs/$slug`; `Orgs` in the nav.

## Findings

- **Six org routes never declared their path parameters** in the
  OpenAPI registry (join, requests, approve/reject, add member, remove
  member, set role) — the same defect class Phase 5a fixed twice on
  `/users`. The SDK's types surfaced two; auditing the file surfaced
  the other four. All fixed in the contract; `openapi.json` and the
  generated SDK moved accordingly.
- Third time this class has appeared → the registry deserves a
  completeness check. Noted as future work: assert every `{param}` in a
  registered path has a matching `request.params` shape.

## Rulings

- **R1 — no separate `/orgs/{slug}/me`.** The roster is visible to
  anyone who can see the org, so membership is derivable client-side.
  Cost if wrong: a private-roster feature later forces the endpoint.
- **R2 — the UI never offers demoting yourself.** The API answers 409
  for the last owner; the UI removes the temptation entirely (own row
  has no role select). Leave stays available and surfaces the API's
  detail when refused.

## Mutation evidence (isolated, restored green after each)

| Mutation | Result |
| --- | --- |
| invite-only gate dropped from Join | 1 fail |
| `requested` outcome treated as joined | 1 fail |
| any member counted as decider | 1 fail |
| own row offered a role select | 1 fail |

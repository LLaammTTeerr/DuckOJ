# Phase 3e — Organization membership: ledger

**Spec:** `docs/superpowers/specs/2026-08-22-phase-3e-org-membership-design.md`

**Result:** 743 tests green (was 731). Migration `0012`. Organizations can be
joined, requested, decided, staffed and left.

---

## R1 — the invariant, in one place

**An organization always has at least one owner.** The last owner cannot leave,
be demoted, or be removed — by anyone, including a global admin.

Three routes could strand an organization, so the rule lives in one private
method that all three call. Three copies would be three chances to leave an org
with nobody who can administer it, and the only repair for that is editing the
database by hand.

The test exercises all three paths *and* a second global admin, because the
invariant is about the organization, not about who is asking. A companion test
promotes a second owner and asserts all three then succeed — otherwise
"refuse every owner removal" would pass the first test and be wrong.

## R2 — no invitation entity

`join_policy = 'invite'` means an owner or admin adds members directly; their
action is the decision. `org_join_requests` models a *request* — user asking
organization — and an invitation is the opposite direction with no table.

**The cost, stated rather than hidden: a user can be added to an organization
without consenting.** That is DMOJ's behaviour, and an organization roster is
not a credential — being listed grants access to that organization's problems,
nothing of the user's. An invitation entity would need accept/decline, expiry
and notification, all to express what the direct add already does.

## R3 — 202 for a request, 201 for a join

Different outcomes get different status codes, and `outcome` is in the body as
well. Conflating them would let a client that checks for `201` believe it had
joined when it had only asked.

## R4 — one pending request, enforced by a partial index

`uniqueIndex(org_id, user_id) WHERE state = 'pending'` — the same shape as
Phase 2b's one-published-revision index.

**Partial**, so a rejection does not bar a later request: a rejection is a
decision about a moment, not a ban. The test fires three concurrent joins
rather than three sequential ones, because a read-then-write pre-check passes
the sequential version and races to two rows an approver would then see twice.

## R5 — deciding a decided request is 409, not a no-op

The second decider believes they are acting on a live request and they are not.
A silent success tells them their decision took effect.

`decided_by` and `decided_at` have existed since Phase 3c and nothing had ever
written them; this phase is the first thing to fill them, and the test asserts
the value rather than merely that it is non-null.

## R6 — "strictly below", and the test that exists because it reads the same

`rank[mine] <= rank[targetRole]` rejects; writing `<` instead lets an admin
remove another admin and reads identically. Nothing on a happy path notices.

Mutating `<=` to `<` reddens exactly one test, which is the one written for it.

## R7 — a mutation that survived a green suite, again

Removing the "only an owner may grant a rank" check did not fail anything. The
escalation test used a *plain member*, who is stopped earlier by the edit check
and therefore never reaches the rank check at all.

Added a test with an **org admin** — someone who passes the edit check, so that
rule is the only thing between them and minting an owner. The mutation now
reddens.

**This is the third phase running where a surviving mutant pointed at a state
no fixture reached**, rather than at a wrong line. The tell is consistent: the
mutation lives behind a guard the test corpus stops short of.

## R8 — mutation evidence

| Mutation | Result |
|---|---|
| M1 last-owner check off by one (`<= 1` → `<= 0`) | 1 fail |
| M2 rank comparison below-or-equal | 1 fail |
| M3 a decided request can be decided again | 1 fail |
| M4 duplicate pending requests allowed | 1 fail |
| M5 an org admin may grant any role | **survived; see R7**, then 1 fail |

## Deferred

**Leaving is `DELETE /orgs/:slug/members/:username` with your own name**, not a
separate `/leave`. One code path answers "may this removal happen", and it
already had to answer "yes, if it is me".

**Nothing notifies anyone.** A user whose request is approved or rejected finds
out by looking. That needs the email subsystem, which does not exist and which
foundation §15 still lists as an open question — the provider is a user
decision.

**Organization-scoped problem visibility already works** through the existing
`problem_orgs` predicate, so joining an organization immediately widens what
its members can see. Nothing extra was needed here, which is what the
cross-cutting design in the foundation spec bought.

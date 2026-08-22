# Phase 3e — Organization membership: design

**Status:** approved for implementation.
**Predecessors:** Phase 3c (org read/write routes), foundation §"organizations
are cross-cutting".

---

## 1. What this phase is

Organizations have a full permission model — three roles, three join policies,
a join-request state machine — and **no way to join one.** `org_members` rows
exist only where a test or `POST /orgs` put them, and `org_join_requests` has
never had a row written to it by anything.

This is the same shape 4d fixed for contests: a subsystem that is complete
except for the door.

## 2. There is no invitation entity, and `invite` means what it says

`org_join_requests` models a *request* — user asking an organization. An
invitation is the opposite direction and has no table.

**It is not getting one.** Under `join_policy = 'invite'`, an owner or admin
adds a member directly; their action *is* the decision. A pending-invitation
entity would need its own accept/decline flow, its own expiry question, and its
own notification story, all to express something the direct add already does.

The cost, stated plainly: **a user can be added to an organization without
consenting.** That is how DMOJ behaves, and an organization roster is not a
credential — being listed in one grants access to that organization's problems,
not to anything of the user's. If consent ever matters, the invitation entity
is a later phase, not a reason to build it now.

## 3. The invariant everything else hangs off

> **An organization always has at least one owner.**

The last owner cannot leave, be demoted, or be removed — by anyone, including a
global admin. An organization with no owner is unadministrable: nobody can add
members, nobody can promote a replacement, and the only repair is a database
edit.

Enforced in **one** place, checked by every path that could remove ownership
(leave, remove, role change), because three copies of this rule is three
chances to leave an org stranded.

## 4. Who may act on whom

Roles are ordered `owner > admin > member`. **An actor may only act on someone
strictly below them**, and only an owner may grant or revoke `owner`.

| Action | owner | admin | member |
|---|---|---|---|
| add a member | yes | yes | no |
| remove a member | yes | yes | no |
| remove an admin | yes | no | no |
| remove an owner | yes (unless last) | no | no |
| set any role | yes | no | no |
| approve/reject a request | yes | yes | no |
| leave | yes (unless last owner) | yes | yes |

A **global admin** may do anything an owner may, which is the same rule every
other access service in this codebase applies, not a new one.

## 5. Joining

```
POST /orgs/:slug/join
```

| `join_policy` | Result |
|---|---|
| `open` | membership created immediately, `201` |
| `request` | a pending request, `202` |
| `invite` | `403 org_invite_only` |

`202` for a request, not `201`: the caller's intent was accepted and nothing
has been created that they can read back as a membership. Conflating the two
would make a client that checks for `201` believe it had joined.

**At most one pending request per user per organization**, enforced by a
partial unique index — the same shape as the "one published revision per
problem" index from Phase 2b, and for the same reason: two concurrent requests
must collide in the database rather than race to two rows an approver then sees
twice.

Re-requesting while pending is **idempotent** — the existing request comes
back. Re-requesting after a rejection is **allowed**: a rejection is a decision
about a moment, not a ban. Requesting when already a member is `409`.

## 6. Deciding

```
GET  /orgs/:slug/requests                  pending only, owner/admin
POST /orgs/:slug/requests/:id/approve
POST /orgs/:slug/requests/:id/reject
```

Approval creates the membership and marks the request `approved`, in one
transaction — a request approved without a membership, or a membership without
the audit row, are both worse than a failure.

Only a `pending` request may be decided; deciding a decided one is `409`, not a
silent no-op, because the second decider is acting on information they think is
current and is not.

`decided_by` and `decided_at` are written on every decision. The columns exist;
this phase is the first thing to fill them.

## 7. Membership routes

```
POST   /orgs/:slug/members                 { username, role? }   owner/admin
DELETE /orgs/:slug/members/:username       owner/admin, or yourself
PATCH  /orgs/:slug/members/:username       { role }              owner
```

**Leaving is `DELETE .../members/:username` with your own name**, not a separate
`/leave` route. One code path decides whether a removal is allowed, and "am I
allowed to remove this person" already has to answer "yes, if it is me".

## 8. Testing

1. **The last owner cannot leave, be demoted, or be removed** — three paths,
   three tests, and a global admin refused as well.
2. **A second owner makes all three legal**, so the rule is "the last one", not
   "owners are immovable".
3. **Each join policy does its own thing**, asserted by status code: `201`,
   `202`, `403`.
4. **A duplicate pending request returns the first**, and the partial index is
   shown to be what prevents two — by inserting concurrently, not by trusting
   the read-then-write.
5. **Re-requesting after rejection is allowed.**
6. **Deciding a decided request is 409.**
7. **Approval is atomic**: no membership without the request marked approved.
8. **An admin cannot remove an admin or an owner**; an owner can.
9. **A non-member cannot list requests**, and a member who is not owner/admin
   cannot either.
10. Every new test demonstrated to fail against unfixed code.

## 9. Risks

**Test 1 is the phase's acceptance criterion.** Every other rule here is
recoverable by an administrator; stranding an organization with no owner is
not, and it is reachable through three different routes.

**The role comparison is where an off-by-one lives.** "Strictly below" is easy
to write as "below or equal" and it reads the same; an admin removing another
admin is then legal, and nothing in a happy-path test notices. It has its own
test for that reason.

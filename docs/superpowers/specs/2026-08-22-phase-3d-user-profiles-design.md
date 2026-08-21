# Phase 3d — User profiles: design

**Status:** approved for implementation.
**Predecessors:** Phase 3a/3b/3c. Closes the largest remaining hole in the
read surface.

---

## 1. What this phase is

**There is no way to look up a user.** The only user-shaped route in the whole
API is `PATCH /admin/users/:username`, which changes a role and is admin-only.
`GET /auth/me` returns the caller and nobody else.

Meanwhile `users` already carries `about`, `avatarKey`, `country`, `timezone`,
`locale`, `rating` and `maxRating` — seven columns no endpoint has ever
returned. This phase gives them a surface, and gives the rating work that
follows somewhere to land.

## 2. Endpoints

```
GET   /users             @Public()  @RequireScope('users:read')   search, paginated
GET   /users/:username   @Public()  @RequireScope('users:read')   the public profile
PATCH /users/me                     @RequireScope('users:write')  edit your own
```

`users:read` and `users:write` are new scopes; the vocabulary pin in
`packages/contracts/test/scopes.spec.ts` lists them explicitly and must be
updated by hand — it is deliberately not derived from `SCOPES`, which would
make it tautological.

**`PATCH /users/me`, not `PATCH /users/:username`.** An admin changing someone
else's profile is a different action with different rules, and giving it the
same route means one handler deciding which of two policies applies. `/me` can
never be mistaken for the other one.

## 3. What is public, and what is not

| Field | Public | Why |
|---|---|---|
| `username`, `displayName`, `about`, `country` | yes | this is what a profile *is* |
| `globalRole` | yes | a setter/admin badge is useful and reveals nothing |
| `rating`, `maxRating` | yes | the point of having them |
| `createdAt` | yes | "member since" |
| `email` | **no** | never, to anyone but the owner |
| `status` | **no** | whether an account is suspended is a moderation fact |
| `timezone`, `locale` | **no** | personal preferences, not identity |
| `avatarKey` | **omitted this phase** | there is no upload route and no object-store URL scheme; returning a key nobody can resolve is worse than omitting it |

**A suspended user's profile still resolves.** Hiding it would turn the profile
route into an oracle for who has been banned, which is exactly what keeping
`status` private is meant to prevent.

## 4. Statistics, counted over public problems only

```
solvedCount     distinct problems with at least one AC
points          sum over problems of the viewer's best score
submissionCount total submissions
```

**All three count only `visibility = 'public'` problems.** This matches
DMOJ — `calculate_points` runs against `Problem.get_public_problems()` — and it
is the property that matters here: a count computed over *what the viewer may
see* would differ per viewer, making a profile mean different things to
different readers and leaking, through arithmetic, that private problems exist.

A stable, public-only number is worth more than a complete one.

**Computed on read, not stored.** DMOJ denormalises `problem_count` onto the
profile and recomputes it on submission events; that is a second write path
that can drift, and this project already deleted one such column this week
(`contest_submissions.points`). Revisit when a query plan says so, not before.

## 5. Search

`GET /users?q=` filters on a case-insensitive prefix of `username` or
`displayName`, paginated with the same cursor shape as every other list.

**Prefix, not substring.** `LIKE '%q%'` cannot use an index and turns the user
table into a sequential scan for anyone who types two letters; the existing
`users_username_lower_idx` serves a prefix directly. A user directory that
degrades with signups is the failure mode this project keeps writing down.

## 6. Testing

1. **`email`, `status`, `timezone` and `locale` never appear** in either the
   profile or the search response — asserted on the whole body, not by
   checking a few fields, so a field added later is caught.
2. **The statistics count public problems only**: a viewer with an AC on a
   private problem and an AC on a public one has `solvedCount` 1, and the same
   number is returned to an anonymous caller, the owner, and an admin. Equality
   across the three is the assertion — it is what "viewer-independent" means.
3. **`points` is the best score per problem**, not the sum of all submissions.
4. **A suspended user's profile still resolves**, and does not say so.
5. **`PATCH /users/me` cannot change `username`, `email`, `globalRole` or
   `rating`** — rejected by the schema, not silently dropped.
6. **Search is a prefix match**, and paginates.
7. **An unknown username 404s.**
8. Every new test demonstrated to fail against unfixed code.

## 7. Risks

**Test 2 is the one most likely to pass against a wrong implementation.** In
any fixture where every problem is public, a query that forgot the visibility
filter returns the same number. It needs a private problem the user has solved,
and that fixture is the only thing separating a correct implementation from a
plausible one.

**Username immutability is assumed, not enforced by this phase.** Nothing here
changes a username; `PATCH /users/me` simply does not accept the field. A
rename feature would have to decide what happens to every citation of the old
name, which is a bigger question than a profile edit.

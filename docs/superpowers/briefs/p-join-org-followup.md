# Small API follow-up (queued by F-30)

`JoinContestRequest` is `.strict({ teamSlug })`. When a member is on two
same-slug teams in different orgs of one contest, the web picker (F-30) now
lets them SEE and choose the right one (composite `orgSlug/slug` option), but
join can only send the bare slug, so the server falls back to B-23's
deterministic lowest-id-the-caller-is-on tiebreak. To honour the pick, add
`orgSlug` (or a team id) to `JoinContestRequest` and `joinAsTeam`, keeping the
slug path for the common single-team case. Small; do in a future F-slot.

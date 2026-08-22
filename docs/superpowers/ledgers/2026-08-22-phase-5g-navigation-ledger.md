# Phase 5g — navigation: every entity links: ledger

**Trigger:** the user: "a lot of problems with the UI now, mainly the
lack of hyperlink." A per-screen audit confirmed nine dead ends.

## What shipped

- **`/submissions/$id` — a page that did not exist.** Every old
  submission was unreachable: the list showed rows and nothing opened.
  The detail renders the same `VerdictPanel` the live submit screen
  uses (one verdict renderer in this app), plus metadata links and the
  source.
- **Deep-linkable submissions filters** (`?problem=`, `?user=`) via
  `validateSearch`; the problem page links "Submissions" and profiles
  link "Their submissions".
- Now links, that were text: problems-list **name** (code alone was the
  only target), submissions **username** and **id**, the nav's
  **signed-in display name** (→ own profile), scoreboard **problem
  labels**, admin panel **contest names**.
- New entry points: **New problem** on the problems list
  (setter/admin), **Edit / Revisions** on the problem page for listed
  members and setters/admins (courtesy links; the pages re-decide).
- Two defects from the screenshot review: the **phone nav now wraps**
  instead of clipping "Sign in" at 390px, and the ME column's stray
  `.` glyph is gone — `pend`'s dot means "still grading" on the submit
  screen, and a problem never attempted is not pending anything; it is
  a plain muted dash now. Both re-verified by fresh screenshots.

## Mutation evidence (isolated, restored green after each)

| Mutation | Result |
| --- | --- |
| every signed-in viewer counted as author | 1 fail |
| deep-link filters ignored | 1 fail |
| detail page fetches a hardcoded id | 1 fail |

Plus the two deliberate test updates the ME-badge change forced, each
rewritten to pin the new behaviour rather than deleted.

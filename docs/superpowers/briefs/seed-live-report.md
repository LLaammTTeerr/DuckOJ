# Live-stack seed report — first admin, five demo problems, student AC/WA, one contest

Run against the running podman-compose stack (`duckoj_*` containers, project
`duckoj`, network `duckoj_default`) reachable at `http://localhost:8080`
(`/api/v1`). No source file was edited, no container was stopped, restarted or
rebuilt. Only `docs/superpowers/briefs/seed-live-report.md` and `.gitignore`
(one line) are committed by this task.

## 1. First admin — `duckadmin`

`scripts/bootstrap-admin.ts` (and the `bootstrap:admin` root script) exist in
the current worktree, but the live `localhost/duckoj_migrate:latest` image is
6 days old and predates the script — a one-off container from it 404s on
`/app/scripts/bootstrap-admin.ts` (`ERR_MODULE_NOT_FOUND`). Rebuilding that
image was out of scope (no rebuild allowed), so the runbook's documented
**recovery fallback** was used instead — register normally through the public
API, then promote with the single `UPDATE` the runbook keeps for exactly this
case ("Bootstrapping the first admin", "Recovery fallback"):

```
curl -sS -X POST http://localhost:8080/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"duckadmin","email":"duckadmin@bootstrap.local","password":"<redacted>","displayName":"Duck Admin"}'
# -> {"id":31,...,"globalRole":"user",...}

podman exec -i duckoj_postgres_1 psql -U duckoj -d duckoj -c \
  "UPDATE users SET global_role = 'admin' WHERE lower(username) = lower('duckadmin') RETURNING id, username, global_role;"
# -> 31 | duckadmin | admin

curl -sS -c oj.admin.cookies -X POST http://localhost:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"usernameOrEmail":"duckadmin","password":"<redacted>"}'
# -> {"user":{...,"globalRole":"admin",...}}
```

Password recorded only in `/home/lamter/Projects/duckoj/.secrets/duckadmin.txt`
(`chmod 600`, directory `chmod 700`). `.secrets/` was not previously
gitignored; added `.secrets/` to `.gitignore` (the one line committed
alongside this report). `git check-ignore -v .secrets/duckadmin.txt` confirms
it is ignored.

## 2. Five demo problems — `content/problems/*`

Followed `content/README.md` exactly, against `http://localhost:8080/api/v1`
(not `https://localhost:8443` — the task pointed at the plain-HTTP published
port, which answers identically). Steps 1–2 (`polygon:import`, `package:build`)
are pure local file work and needed nothing running:

```
for code in tong-hai-so so-nguyen-to day-con-tang duong-di-ngan-nhat cay-khung-nho-nhat; do
  corepack pnpm polygon:import "content/problems/$code" "/tmp/pkg-$code"
  corepack pnpm --silent package:build "/tmp/pkg-$code" "/tmp/$code.tar.zst"
done
```

All five imported clean: 12 tests each, checker `standard`, `skipped: statements`
/ `skipped: solutions` as expected. `package:build` hashes (25 files each):

| code | hash | bytes |
| --- | --- | --- |
| tong-hai-so | `9fad4a92adb4686a71bf482bbd24475148417475586e738d33af26fb003d8499` | 706 |
| so-nguyen-to | `388230da82a9a2fc446f7df394764520a0ae94c2f2de7e252785d431c111e6b0` | 639 |
| day-con-tang | `c057421d6450b112834f6eb24e3427764a5b2bfe9009f3a8ffbb64b58804026b` | 89844 |
| duong-di-ngan-nhat | `c4eab4731aea75ea3222cfb6a2ba55e065b5cf7c6b22c863a03441484fe66abd` | 146335 |
| cay-khung-nho-nhat | `e7095355407ffd117d76c45d027e4c23a61ca844d90c70485503fca287592638` | 129653 |

Then, as `duckadmin` (session cookie), for each `code`: create problem
(`POST /problems`, `visibility:"private"`) → upload archive
(`POST /packages?hash=<hash>`) → attach revision (`POST /problems/<code>/revisions`)
→ publish (`POST /problems/<code>/revisions/1/publish`) → make public
(`PATCH /problems/<code>` `{"visibility":"public"}`) — the loop from
`content/README.md`'s "Importing all five into a running stack" section, run
verbatim (base URL swapped to `http://localhost:8080/api/v1`, no `-k` needed).
All five: `attach` → `{"version":1}`, `publish` → `{"version":1}`, final
`PATCH` → `"hasPublishedRevision":true`.

**Verification:**

```
$ curl -sS http://localhost:8080/api/v1/problems/tong-hai-so | jq '.code,.visibility,.hasPublishedRevision,.testCount'
"tong-hai-so" "public" true 12
# ...identical shape for the other four (so-nguyen-to, day-con-tang, duong-di-ngan-nhat, cay-khung-nho-nhat)

$ curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:8080/problems/tong-hai-so
200   # SPA index.html; fetches the problem client-side from the (already-verified) API
```

All five: `visibility:"public"`, `hasPublishedRevision:true`, `testCount:12`,
page `200`.

## 3. Student `hocsinh1` — five AC, one WA

```
curl -sS -X POST http://localhost:8080/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"hocsinh1","email":"hocsinh1@bootstrap.local","password":"<redacted>","displayName":"Hoc Sinh 1"}'
# -> {"id":32,...}

curl -sS -c oj.student.cookies -X POST http://localhost:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"usernameOrEmail":"hocsinh1","password":"<redacted>"}'
```

Password recorded in the same `.secrets/duckadmin.txt` file, under a `---`
separator.

Submitted each `content/problems/<code>/solution.cpp` as `languageKey:"cpp17"`:

```
jq -n --arg code "$code" --rawfile src "content/problems/$code/solution.cpp" \
  '{problemCode:$code, languageKey:"cpp17", source:$src}' \
  | curl -sS -b oj.student.cookies -X POST http://localhost:8080/api/v1/submissions \
      -H 'content-type: application/json' --data-binary @-
```

then polled `GET /api/v1/submissions/<id>` every 2s until `state` left
`queued`/`compiling`/`grading`. Verdict lines:

```
tong-hai-so        (id=31): state=done verdict=AC points=100/100
so-nguyen-to       (id=32): state=done verdict=AC points=100/100
day-con-tang       (id=33): state=done verdict=AC points=100/100
duong-di-ngan-nhat (id=34): state=done verdict=AC points=100/100
cay-khung-nho-nhat (id=35): state=done verdict=AC points=100/100
```

All five model solutions reached AC, 100/100.

**Deliberately wrong solution → WA.** Submitted `a - b` instead of `a + b`
against `tong-hai-so`:

```cpp
#include <bits/stdc++.h>
int main() {
    long long a, b;
    std::cin >> a >> b;
    std::cout << (a - b) << std::endl;   // deliberately wrong
    return 0;
}
```

```
wrong submission id=36
tong-hai-so (wrong, id=36): state=done verdict=WA points=0/100
```

## 4. Contest `thu-nghiem-1`

Body shaped from `packages/contracts/src/contests.ts`'s `CreateContestRequest`
(`key`, `name`, `startTime`/`endTime` as `Timestamp` = ISO datetime with
offset, `format`, `visibility`, `problems: [{code, points, partial}]` — no
`.strict()` fields beyond that schema), posted as `duckadmin`:

```
START=$(date -u +%FT%TZ)          # 2026-08-29T08:46:59Z at plan time
END=$(date -u -d '+30 days' +%FT%TZ)

jq -n --arg start "$START" --arg end "$END" '{
  key: "thu-nghiem-1",
  name: "Kỳ thi thử nghiệm 1",
  startTime: $start, endTime: $end,
  format: "icpc", visibility: "public",
  problems: [
    {code:"tong-hai-so", points:100, partial:true},
    {code:"so-nguyen-to", points:100, partial:true},
    {code:"day-con-tang", points:100, partial:true},
    {code:"duong-di-ngan-nhat", points:100, partial:true},
    {code:"cay-khung-nho-nhat", points:100, partial:true}
  ]
}' | curl -sS -b oj.admin.cookies -X POST http://localhost:8080/api/v1/contests \
      -H 'content-type: application/json' --data-binary @-
```

Response: `{"id":3,"key":"thu-nghiem-1","name":"Kỳ thi thử nghiệm 1",
"startTime":"2026-08-29T08:47:08.000Z","endTime":"2026-09-28T08:47:08.000Z",
"format":"icpc","visibility":"public",...,"problems":[...all five, labels "1".."5"...]}`.

Verified with an anonymous `GET /api/v1/contests/thu-nghiem-1` — same key,
name, format, visibility `public`, all five problems present (`canEdit:false`
for the anonymous caller, as expected).

## What exists on the live stack now

- Admin `duckadmin` (`global_role=admin`), student `hocsinh1` — both real
  accounts, passwords only in `.secrets/duckadmin.txt` (mode 600, dir 700,
  gitignored).
- Five public, published problems: `tong-hai-so`, `so-nguyen-to`,
  `day-con-tang`, `duong-di-ngan-nhat`, `cay-khung-nho-nhat` — each revision 1,
  12 tests, visible at `GET /api/v1/problems/<code>` and
  `http://localhost:8080/problems/<code>`.
- Ten submissions from `hocsinh1` in this run: five AC (ids 31–35, one per
  problem, 100/100 each) plus one deliberate WA against `tong-hai-so` (id 36,
  0/100).
- Contest `thu-nghiem-1` ("Kỳ thi thử nghiệm 1"), format `icpc`, visibility
  `public`, started now, ends in 30 days, all five problems attached at 100
  points each, unrated.
- The database already had 30 pre-existing users (`duckadmin` landed as id 31,
  `hocsinh1` as id 32) and two contests before this run (`thu-nghiem-1` landed
  as id 3) — this is a live, shared stack with other activity on it, not a
  fresh one.

## Concerns

1. **The live `duckoj_migrate:latest` image is stale relative to the
   worktree** — it lacks `scripts/bootstrap-admin.ts`, which exists in the
   current source tree (per `docs/superpowers/briefs/p4-bootstrap-content-report.md`).
   `bootstrap:admin` as documented cannot be run against this stack until that
   image is rebuilt; the recovery-fallback path (register + `UPDATE`) was
   used instead, which is itself documented as the intended fallback, not an
   improvisation.
2. Both new accounts have `emailVerified:false` — registration through the
   public API does not verify email (only `bootstrap-admin.ts` does that).
   Nothing observed gates on this today (`MeResponse`'s own comment: "Nothing
   is gated on this yet"), but it is a difference from what
   `bootstrap:admin` would have produced.
3. This is a live, concurrently-edited stack — another agent's commits landed
   mid-task (the `api` container restarted partway through, ~1 minute before
   this task's first request), so the exact commit the live containers are
   running may have moved since. All requests above were still answered
   correctly by whatever was live at request time; nothing here waited on or
   depended on the other agent's changes.
4. Page-render verification for the five problems (`http://localhost:8080/problems/<code>`)
   confirmed the SPA shell serves `200` and is genuinely `index.html` (not a
   Caddy fallback edge case) — the actual per-problem data fetch is
   client-side JS, already independently confirmed working via the
   `GET /api/v1/problems/<code>` calls above, but no headless browser was
   used to observe the rendered DOM itself.

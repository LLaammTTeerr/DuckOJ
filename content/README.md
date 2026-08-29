# `content/` — five demo problems in Polygon layout

Five classic provincial-olympiad problems, ascending in difficulty, laid out
the way `packages/polygon-import` expects a Polygon "full" package:

| Directory | Problem | Algorithm | TL |
| --- | --- | --- | --- |
| `problems/tong-hai-so/` | Tổng hai số | $a + b$ | 1 s |
| `problems/so-nguyen-to/` | Đếm số nguyên tố | sieve, $N \le 10^7$ | 2 s |
| `problems/day-con-tang/` | Dãy con tăng dài nhất | LIS, $O(N \log N)$ | 2 s |
| `problems/duong-di-ngan-nhat/` | Đường đi ngắn nhất | Dijkstra | 2 s |
| `problems/cay-khung-nho-nhat/` | Cây khung nhỏ nhất | Kruskal + DSU | 2 s |

This directory is **source**, not a package. `problems/` at the repo root is
a different thing — those are already-built DuckOJ package directories that
`scripts/seed-problem.ts` seeds directly. These have to go through
`polygon:import` first.

## What is in each directory

    problem.xml     the Polygon descriptor — the only file that decides what
                    reaches a package (see "What gets copied" below)
    statement.md    Vietnamese statement with an English section (D10)
    solution.cpp    the model solution; every tests/NN.a is its own output
    gen.py          regenerates tests/ from scratch, deterministically
    tests/01 .. 12  inputs, and 01.a .. 12.a their answers

Twelve tests each: `01`–`02` are the samples quoted in the statement (group
`samples`, 0 points), `03`–`07` are the small group `nho` (8 points each, 40
total), `08`–`12` the large group `lon` (12 points each, 60 total).

**What gets copied.** `importPolygon` copies only the paths `problem.xml`
names — the twelve inputs and twelve answers, and a checker if one were
declared. `statement.md`, `solution.cpp` and `gen.py` stay here and never
enter the package, so they cannot change the content-addressed hash a
submission is graded against. The importer says so on every run
(`skipped: statements`, `skipped: solutions`).

**No checker.** Every answer is a single integer, so the standard token
comparison is the whole of what a `wcmp`-style checker would do; a
checkerless Polygon package imports as `{"kind":"standard"}`.

**Test sizes.** The committed tests are deliberately below the stated bounds
— the largest is $N = 5000$ for `day-con-tang` and $N = 2000 / M = 5000$ for
the two graph problems, about 1.2 MB of test data in total for all five.
These files live in git. Each generator has a `LARGE_N`/`LARGE_M` constant
at the top: raise it and re-run to produce bound-sized data for a real judge
run.

## Regenerating the tests

    python3 content/problems/day-con-tang/gen.py

Each generator compiles `solution.cpp` with `g++ -O2 -std=c++17` and writes
every `tests/NN` together with the `tests/NN.a` that solution produced for
it in the same run, so a test and its answer can never come from different
versions of the solution. The seeds are fixed, so re-running reproduces the
committed files byte for byte.

## Importing all five into a running stack

The sequence below is `polygon:import` → `package:build` → upload → attach →
publish, using the scripts and routes documented in `docs/runbook.md`
("A second problem: building, uploading, and diagnosing a package" and
"Phase 2b: authoring a problem"). It needs a session cookie for an account
with `setter` or `admin` standing — see "Bootstrapping the first admin" in
the runbook for `corepack pnpm bootstrap:admin`, which mints one.

    BASE=https://localhost:8443/api/v1

    curl -sk -c oj.cookies -X POST "$BASE/auth/login" \
      -H 'content-type: application/json' \
      -d '{"usernameOrEmail":"admin1","password":"..."}'

    for code in tong-hai-so so-nguyen-to day-con-tang duong-di-ngan-nhat cay-khung-nho-nhat; do
      # 1. Polygon layout -> DuckOJ package directory (manifest.json + tests/).
      corepack pnpm polygon:import "content/problems/$code" "/tmp/pkg-$code"

      # 2. Package directory -> deterministic, content-addressed archive.
      HASH=$(corepack pnpm --silent package:build "/tmp/pkg-$code" "/tmp/$code.tar.zst" \
             | python3 -c 'import json,sys; print(json.load(sys.stdin)["hash"])')

      # 3. Create the problem row. The statement is this directory's
      #    statement.md; --rawfile keeps its newlines and Vietnamese intact.
      NAME=$(python3 -c "import sys,re; print(re.sub(r'^#\s*','',open(sys.argv[1],encoding='utf-8').readline().strip()))" \
             "content/problems/$code/statement.md")
      jq -n --arg code "$code" --arg name "$NAME" \
            --rawfile statement "content/problems/$code/statement.md" \
            '{code:$code, name:$name, statement:$statement, visibility:"private"}' \
        | curl -sk -b oj.cookies -X POST "$BASE/problems" \
            -H 'content-type: application/json' --data-binary @-

      # 4. Upload the archive. The server re-derives the hash and rejects a
      #    mismatch (422), so a stale archive is caught here.
      curl -sk -b oj.cookies -X POST "$BASE/packages?hash=$HASH" \
        -H 'content-type: application/octet-stream' \
        --data-binary "@/tmp/$code.tar.zst"

      # 5. Attach it as revision 1 and publish it.
      curl -sk -b oj.cookies -X POST "$BASE/problems/$code/revisions" \
        -H 'content-type: application/json' \
        -d "{\"packageHash\":\"$HASH\",\"notes\":\"demo content import\"}"
      curl -sk -b oj.cookies -X POST "$BASE/problems/$code/revisions/1/publish"

      # 6. Make it public, and classify it. `tags` are slugs from `GET /tags`
      #    (seeded by migration 0018); `difficulty` is the setter's own 1-10
      #    estimate. Both come out of `content/tags.json`, which is the
      #    record of what this demo set is classified as — see below.
      jq -c --arg code "$code" '.[$code] + {visibility:"public"}' content/tags.json \
        | curl -sk -b oj.cookies -X PATCH "$BASE/problems/$code" \
            -H 'content-type: application/json' --data-binary @-
    done

## Topics and difficulty

`tags.json` holds, per problem code, the topic slugs and the 1-10 difficulty
the demo set is classified under. It is **data, not a step that runs itself**:
nothing in the seed path reads it, and the loop above applies it through the
ordinary `PATCH /problems/{code}` the API exposes to any setter. Keeping it in
git is what stops a rebuilt stack from ending up classified differently from
the last one — or, more likely, not classified at all.

An unknown slug is refused with 422 `problem_tag_unknown`, so a typo here
fails the PATCH loudly rather than quietly dropping a topic. `tags` is a
whole-set replacement, not a merge: what is in this file is exactly what the
problem ends up carrying.

Note what a tag is NOT for: **D35 hides both tags and difficulty from a
viewer who is sitting a running contest that uses the problem**, because a
tag is a third of the hint on a hard problem. Classifying the demo set does
not leak anything into a contest built from it.

Step 3 is separate from step 4 on purpose: uploading a package and having
standing to attach it to a problem are different permissions, and the
problem row carries the statement, which never enters the package.

Steps 1 and 2 need nothing running — they are pure local file work, and are
worth doing first to confirm every directory still imports before any of it
touches a live stack.

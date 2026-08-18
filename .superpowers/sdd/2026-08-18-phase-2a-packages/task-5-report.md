# Task 5 report: `package build` — turn a directory into a package

## Status: DONE

## Commit

`05d9bcd` — feat(scripts): build a content-addressed package from a directory

## Files

- Created: `problems/aplusb/manifest.json` (verbatim from the brief)
- Created: `scripts/lib/build-package.ts` — shared build logic (`buildPackage(dir)`), used by `scripts/package-build.ts` and intended for reuse by a later seed script, per the brief's correction. **Not** inlined into the CLI.
- Created: `scripts/package-build.ts` — CLI wrapper: parses argv, calls `buildPackage`, writes the archive, prints JSON, wraps errors in try/catch with `process.exit(1)`.
- Modified: root `package.json` — added `package:build` script and `@qhhoj/package-format: workspace:*` to `dependencies`.
- Modified: `scripts/tsconfig.json` — `include` widened from `["*.ts"]` to `["*.ts", "lib/**/*.ts"]` so `scripts/lib/build-package.ts` is a typechecked root file (not just pulled in transitively). Not called out in the brief; disclosed here per the "install lists are not authoritative" instruction — this is a tsconfig `include` change, not a package add, but it was necessary for the shared-lib layout the brief requires.
- `pnpm-lock.yaml` updated by `corepack pnpm install` after the root dependency addition.
- `problems/aplusb/init.yml` left untouched, as instructed.

## Deviation from the brief's literal Step 2 code

The brief's Step 2 code sample inlines the build logic directly into `scripts/package-build.ts`. Per the task instructions ("A correction the brief already carries — do not undo it"), I split it: the parse/pack/verify/hash logic lives in `scripts/lib/build-package.ts` as an exported `buildPackage(dir)` function, and `scripts/package-build.ts` is a thin CLI wrapper around it. Behavior is otherwise identical to the brief's script (same validation of manifest-declared files against packed files, same JSON output shape).

## Step 3: first build

```
$ corepack pnpm package:build problems/aplusb /tmp/aplusb.tar.zst

> qhhoj@ package:build /home/lamter/Projects/qhhoj/.claude/worktrees/phase-2a-packages
> tsx scripts/package-build.ts "problems/aplusb" "/tmp/aplusb.tar.zst"

{"hash":"7b2e67c5cb918aa58b9ef91a433ae3e40944c7a26d0367641410ac44775f6cc7","files":8,"bytes":475}
```

`files: 8` matches the brief's expectation exactly (7 pre-existing files + the new `manifest.json`).

## Step 4: reproducibility check

```
$ corepack pnpm package:build problems/aplusb /tmp/aplusb-2.tar.zst

> qhhoj@ package:build /home/lamter/Projects/qhhoj/.claude/worktrees/phase-2a-packages
> tsx scripts/package-build.ts "problems/aplusb" "/tmp/aplusb-2.tar.zst"

{"hash":"7b2e67c5cb918aa58b9ef91a433ae3e40944c7a26d0367641410ac44775f6cc7","files":8,"bytes":475}
```

Hash from run 1: `7b2e67c5cb918aa58b9ef91a433ae3e40944c7a26d0367641410ac44775f6cc7`
Hash from run 2: `7b2e67c5cb918aa58b9ef91a433ae3e40944c7a26d0367641410ac44775f6cc7`

**Byte-identical.** As a bonus check (not required by the brief, but relevant since `packDirectory` documents the archive itself as reproducible even though it isn't what's hashed), I also compared the two `.tar.zst` files directly:

```
$ cmp /tmp/aplusb.tar.zst /tmp/aplusb-2.tar.zst && echo "archives identical"
archives identical
$ sha256sum /tmp/aplusb.tar.zst /tmp/aplusb-2.tar.zst
0af53789e166cd6489c29475dded930863e628c81993f094dcd6319042d698ff  /tmp/aplusb.tar.zst
0af53789e166cd6489c29475dded930863e628c81993f094dcd6319042d698ff  /tmp/aplusb-2.tar.zst
```

Both the package hash and the raw archive bytes are identical across runs.

**The package hash to carry forward to later tasks: `7b2e67c5cb918aa58b9ef91a433ae3e40944c7a26d0367641410ac44775f6cc7`**

## Step 5: gates

```
$ corepack pnpm typecheck:scripts
> tsc -p scripts/tsconfig.json
(clean, no output)

$ corepack pnpm lint:scripts
> eslint scripts
(clean, no output)
```

Also ran the full workspace gates specified in "Global constraints binding this task":

```
$ corepack pnpm -r typecheck   → all 10 workspace packages: Done, no errors
$ corepack pnpm -r lint        → all 10 workspace packages: Done, no errors
$ corepack pnpm -r test        → all packages green (see summary below)
```

## Test summary

Per-package `Tests` counts from `corepack pnpm -r test`:

| package | tests |
|---|---|
| packages/observability | 4 |
| packages/judge-protocol | 18 |
| packages/contracts | 4 |
| packages/sdk | 2 |
| packages/realtime | 1 |
| packages/package-format | 25 |
| packages/db | 8 |
| apps/web | 15 |
| apps/judged | 41 |
| apps/api | 88 |

Total: **206 tests, all passing** — unchanged from the baseline, confirming this task added no unit tests (as expected; its verification is the Step 3/4 real runs above).

## Concerns

None. The manifest matches `init.yml` and the seeded limits exactly, `init.yml` was not touched, the hash is reproducible bit-for-bit across two runs (both the canonical hash and the raw archive bytes), and all required gates pass green.

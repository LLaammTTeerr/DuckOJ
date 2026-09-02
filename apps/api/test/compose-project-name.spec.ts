// F3's concern, verified and closed.
//
// Review finding M4 (see `scripts/restore.sh`'s own header) established that
// `COMPOSE_PROJECT` was the wrong variable: podman-compose knows nothing
// about it, and derives the project from the working directory or from
// `COMPOSE_PROJECT_NAME`. A script that reads only the old name and uses it
// solely to build a `com.docker.compose.project=` label looks up containers
// under one project while compose itself operates on another. `backup.sh` and
// `restore.sh` were fixed then; `scripts/e2e-problem.ts` and
// `scripts/e2e-contest.ts` were not, and still read `COMPOSE_PROJECT` alone.
//
// The consequence is exactly the documented workflow failing. The runbook now
// tells an operator to export `COMPOSE_PROJECT_NAME=duckoj` when working from
// a git worktree — and with that exported and nothing else, these two scripts
// fall through to `basename(REPO_ROOT)`, which in a worktree is
// `agent-<hash>`, and die on "no postgres container found for compose project
// 'agent-…' — is the stack up?" against a stack that is up and healthy.
//
// A source-reading test rather than an execution one, for the same reason
// `dockerfile-manifest.spec.ts` reads Dockerfiles: running these scripts needs
// a whole live stack, and the property that matters — *which environment
// variable is consulted first* — is right there in the file. It lives in
// apps/api/test because that suite is this repo's home for repo-wide checks
// (see that file's header) and because `pnpm -r test` runs it.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptsDir = join(repoRoot, 'scripts');

/** Every script that resolves a compose project name for itself. */
function scriptsResolvingAProject(): { name: string; source: string }[] {
  return readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.sh'))
    .map((name) => ({ name, source: readFileSync(join(scriptsDir, name), 'utf8') }))
    .filter(({ source }) => /COMPOSE_PROJECT/.test(source));
}

describe('compose project resolution across scripts', () => {
  it('finds the scripts that resolve one at all', () => {
    // Pins the set the assertion below iterates over: a new script that grows
    // its own project resolution has to show up here, rather than silently
    // being covered by a test that iterates over nothing.
    const names = scriptsResolvingAProject().map((s) => s.name).sort();
    // `deploy.sh` (B-15) joined the set: it EXPORTS `COMPOSE_PROJECT_NAME`
    // because it builds images in a `git archive` export directory, where
    // podman-compose would otherwise name them after a temp directory — the
    // same M4 disagreement this file exists for, arriving by a new door.
    // F-59 removed `e2e-contest.ts` and `e2e-problem.ts` from this set, and
    // that is a fix rather than a regression: both used to `podman exec` into
    // postgres to promote an account they had registered anonymously, which
    // is why they needed a project name at all. That step is gone — they mint
    // pupils through the API using the operator's own admin — so neither
    // script shells into compose any more and neither can disagree with it.
    // The two names survive in those files only inside comments explaining
    // what was removed, which is why this pin reads the set and not a grep.
    expect(names).toEqual(['backup.sh', 'deploy.sh', 'restore.sh']);
  });

  it('reads COMPOSE_PROJECT_NAME first, everywhere', () => {
    for (const { name, source } of scriptsResolvingAProject()) {
      expect(source, `${name} never mentions COMPOSE_PROJECT_NAME`).toContain('COMPOSE_PROJECT_NAME');
      // Order is the whole property. `COMPOSE_PROJECT ?? COMPOSE_PROJECT_NAME`
      // would satisfy a mere `toContain` while still preferring the alias
      // compose itself ignores.
      const first = source.indexOf('COMPOSE_PROJECT_NAME');
      const alias = source.search(/COMPOSE_PROJECT(?!_NAME)/);
      expect(alias === -1 || first < alias, `${name} consults COMPOSE_PROJECT before COMPOSE_PROJECT_NAME`).toBe(
        true,
      );
    }
  });
});

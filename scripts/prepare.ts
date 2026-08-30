/**
 * `corepack pnpm prepare:problem <problem-dir> [options]` — the problem-preparation
 * gate and publisher (`@duckoj/prepare`).
 *
 * The root script is `prepare:problem` — it was `prepare` for one commit, which
 * is an npm/pnpm LIFECYCLE name: `pnpm install` ran it inside the Docker deps
 * stage, where `scripts/` is not copied, and every image build died. The
 * defensive shape below is kept anyway. (Original note:) `pnpm install`
 * runs this file with no arguments every time anyone installs the workspace.
 * Two consequences are load-bearing and neither is optional:
 *
 *  1. Zero arguments exits 0 in silence. An install must not print a usage
 *     banner, and must certainly not fail.
 *  2. The argument check happens BEFORE any `@duckoj/*` import, and the import
 *     is dynamic. At install time `packages/prepare/dist` does not exist yet —
 *     a static import would make a fresh `pnpm install` crash on a package
 *     that has not been built.
 *
 * `pnpm prepare:problem --help` prints the usage this file deliberately does not.
 */
const argv = process.argv.slice(2);
if (argv.length === 0) {
  // The lifecycle invocation. Nothing to do, nothing to say.
  process.exit(0);
}

const { cli } = await import('@duckoj/prepare/cli');
process.exitCode = await cli(argv);

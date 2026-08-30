/**
 * `@duckoj/prepare` — the problem-preparation gate and publisher.
 *
 * Library first, CLI second: every step below is a function that takes values
 * and returns a report, so `apps/mcp` can expose the same pipeline as tools
 * without shelling out to a binary and parsing its stdout. Nothing in `src/`
 * writes to the console or calls `process.exit`; `cli.ts` is the only file
 * that does either.
 */
export { PrepareError } from './errors.js';
export { detectLayout, loadProblem, type LoadOptions } from './load.js';
export { findStatement, hasEnglishSection, type StatementLookup } from './statement.js';
export { parseSolutionMeta, type SolutionMeta } from './solution-meta.js';
export { findClassification, type Classification } from './classification.js';
export { readFlags, blockingFlags } from './flags.js';
export { distributePoints } from './load-skills.js';
export { validateProblem, formatReport, type ValidateOptions } from './validate.js';
export { packageProblem, type PackagedProblem } from './package.js';
export { publishProblem, type PublishOptions, type PublishResult } from './publish.js';
export { runStress, type StressOptions, type StressResult, type StressCounterexample } from './stress.js';
export { standardJudge, sourceJudge, tokens, type Judge, type CheckOutcome } from './judge.js';
export { compile, run, findTestlib, requireTestlib, NO_TESTLIB } from './toolchain.js';
export * from './model.js';

export * as schema from './schema/index.js';
export { createDb, type Db } from './client.js';
export { runMigrations } from './migrate.js';
export {
  hashJudgeToken,
  verifyJudgeCredential,
  admittedJudgeNames,
  isRevokedTokenHash,
  REVOKED_TOKEN_PREFIX,
  touchJudgeLastSeen,
  recordJudgeCapabilities,
} from './judge-auth.js';
export { reclaimExpiredLeases } from './grading.js';
export { loadDriverLanguageMap, type DriverLanguageMap } from './language-drivers.js';
// Re-exported, not defined here (D159). The arithmetic moved to its own
// zero-dependency package so `apps/web`'s authoring form can apply the SAME
// function to values a setter has typed and not yet saved; `apps/api` and
// `apps/judged` keep importing it from `@duckoj/db`, which is where D154 put
// it and where every call site already looks.
export * from '@duckoj/language-limits';
export {
  contestProblemIdsForSubmissions,
  isTerminalSubmissionState,
  noteContestSubmissionCreated,
  noteContestVerdict,
  recomputeContestProblemStats,
  recomputeContestStats,
  type SubmissionOutcome,
} from './contest-stats.js';

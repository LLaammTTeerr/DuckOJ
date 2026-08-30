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
export {
  contestProblemIdsForSubmissions,
  isTerminalSubmissionState,
  noteContestSubmissionCreated,
  noteContestVerdict,
  recomputeContestProblemStats,
  recomputeContestStats,
  type SubmissionOutcome,
} from './contest-stats.js';

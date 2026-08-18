/**
 * The Redis pub/sub channel `judged`'s `SubmissionEvents` publishes a
 * submission id on, and `api`'s `RedisSubscriber` listens on to forward it to
 * `SubmissionsGateway`. Both sides import this one constant instead of each
 * declaring their own copy of the string: a rename on either side used to be
 * able to pass the entire suite while silently breaking live updates in
 * production, because nothing asserted the two hand-copied values agreed.
 */
export const SUBMISSION_CHANNEL = 'submission';

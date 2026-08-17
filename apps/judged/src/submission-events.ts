import type { Redis } from 'ioredis';

export const SUBMISSION_CHANNEL = 'submission';

/**
 * The ONLY thing in this service that publishes.
 *
 * Redis pub/sub is not transactional: publishing before a write has actually
 * landed lets `api` read submission state that does not exist. PostgreSQL's
 * own NOTIFY would have made that impossible for free — it only fires after
 * the transaction that issued it commits. Redis has no such guarantee, so it
 * is a caller discipline instead: `EventWriter.apply` calls `publish` only
 * after its write has resolved successfully, and only when `apply` is
 * called with a non-transactional `Db` (the real path), so "write resolved"
 * already means "write committed". `apply` must never be called from inside
 * a caller-managed transaction — that combination is not guarded here, only
 * avoided by the caller.
 *
 * The payload is an id, never data. Authorization stays on the HTTP endpoint,
 * where it already works.
 */
export class SubmissionEvents {
  constructor(private readonly redis: Redis) {}

  async publish(submissionId: number): Promise<void> {
    await this.redis.publish(SUBMISSION_CHANNEL, String(submissionId));
  }
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { judgeNodes } from './schema/judging.js';
import type { Db } from './client.js';

/**
 * sha256-hex, matching the convention `apps/api`'s `SessionService` and
 * `TokenService` already use for every other bearer credential this codebase
 * stores (see `apps/api/src/authn/session.service.ts`'s `hashToken`): a
 * stolen database row is not directly replayable as a credential.
 */
export function hashJudgeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Verifies a judge's presented `(name, token)` pair against `judge_nodes`.
 *
 * Both `apps/api` (`JudgeGuard`, protecting the package-fetch endpoint) and
 * `apps/judged` (the bridge's handshake, `BridgeOptions.verifyJudge`) call
 * this — the same query, the same hash, the same comparison — so a token
 * that verifies on one side verifies identically on the other, and there is
 * exactly one place this logic can drift out of sync with itself.
 *
 * Fails closed: any error (a database blip, most plausibly) is caught here
 * and treated as "not verified" rather than left to propagate, so an outage
 * in this path turns into a hard rejection of every judge, never a silent
 * bypass of authentication.
 *
 * Never compares the raw token with `===`: the presented token is hashed the
 * same way the stored hash was produced, then the two digests are compared
 * with `timingSafeEqual` rather than string equality.
 */
export async function verifyJudgeCredential(db: Db, name: string, token: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ tokenHash: judgeNodes.tokenHash })
      .from(judgeNodes)
      .where(eq(judgeNodes.name, name))
      .limit(1);
    const row = rows[0];
    if (!row) return false;

    const presented = Buffer.from(hashJudgeToken(token), 'hex');
    const stored = Buffer.from(row.tokenHash, 'hex');
    // `timingSafeEqual` throws on a length mismatch rather than returning
    // `false`, and a malformed or foreign stored hash must not crash
    // verification — so the length is checked explicitly first.
    if (presented.length !== stored.length) return false;
    return timingSafeEqual(presented, stored);
  } catch {
    return false;
  }
}

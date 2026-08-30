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

/**
 * Bumps `judge_nodes.last_seen` to now for the named judge — the write half
 * of the design's "`lastSeen` gets written on handshake and heartbeat"
 * promise (`docs/superpowers/specs/2026-08-18-phase-2a-packages-design.md`
 * §8). The caller is `apps/judged`'s `BridgeServer`: on a successful
 * handshake, and thereafter on any packet it decodes, throttled to one
 * write per judge per window (D68 — the design's "handshake and heartbeat"
 * under-reported a judge that was mid-grade and talking constantly). That
 * is the same signal its own in-memory `lastSeenAt` map tracks; this just
 * makes that map's answer to "is my judge alive" durable and queryable
 * instead of vanishing on restart.
 *
 * Never throws: a failure to record liveness (a database blip, most
 * plausibly) is an observability gap, not a reason to reject a handshake
 * already verified by `verifyJudgeCredential`, or to drop a heartbeat
 * already trusted. Every caller can therefore fire this and forget it.
 *
 * A name matching no row is silently a no-op (`UPDATE` affects zero rows,
 * which is not an error) — telling "unknown judge" apart from "known judge,
 * database blip" is not this function's job. `verifyJudgeCredential` is
 * what gates whether a caller should be invoking this for a given name at
 * all; a caller that only calls this after a credential already verified
 * (as every current caller does) never actually hits the zero-row case.
 */
export async function touchJudgeLastSeen(db: Db, name: string): Promise<void> {
  try {
    await db.update(judgeNodes).set({ lastSeen: new Date() }).where(eq(judgeNodes.name, name));
  } catch {
    // Swallow — see doc comment above.
  }
}

/**
 * Writes what a judge announced about itself into `judge_nodes.capabilities`
 * — the languages it can run, the executor names it used for them, its
 * concurrency (1, D29) and how many problems it had.
 *
 * The column has existed since the schema's first draft and was written by
 * **nothing** until now (D47's report says so in as many words), so an
 * operator could not answer "which of my judges can run Python" without
 * reading a container's logs, and `judged` could not either — which is why
 * every judge was assumed to run everything. `apps/judged`'s `BridgeServer`
 * calls this once per successful handshake, and that is the only moment the
 * information arrives: DMOJ re-announces problems but never executors.
 *
 * `unknown` rather than a typed shape on purpose: the column is `jsonb`, the
 * shape belongs to the driver that produced it (`JudgeCapabilities` in
 * `apps/judged`), and `@duckoj/db` must not grow a dependency on a driver's
 * vocabulary to store a blob it never interprets.
 *
 * Never throws, on exactly the terms `touchJudgeLastSeen` does not: this is
 * observability, and a failure to record it is not a reason to reject a
 * judge that has already authenticated.
 */
export async function recordJudgeCapabilities(
  db: Db,
  name: string,
  capabilities: unknown,
): Promise<void> {
  try {
    await db.update(judgeNodes).set({ capabilities }).where(eq(judgeNodes.name, name));
  } catch {
    // Swallow — see doc comment above.
  }
}

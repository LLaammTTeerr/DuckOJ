import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@duckoj/db';
import { DB } from '../config/config.module.js';
import { Public } from '../authn/auth.guard.js';
import { MAILER, type Mailer } from '../mail/mailer.js';

/**
 * How long `readyz` waits for the database before answering 503 anyway.
 *
 * A readiness probe's contract is to *answer*. Awaiting the check with no
 * deadline works only for the easy outages — a rejecting stub, a dead port
 * (RST in microseconds) — and fails exactly where a probe earns its keep: a
 * database that accepts the connection and then says nothing. Neither
 * postgres.js nor drizzle imposes a statement timeout, so on that path the
 * probe used to hang indefinitely rather than report anything, which reads to
 * an orchestrator as "the API is wedged" and sends an operator to the wrong
 * container. Each hung probe also holds one of the pool's ten connections,
 * so a 10 s probe interval can drain the pool and take healthy traffic with
 * it.
 *
 * Under the 10 s interval `docker-compose.yml` uses, so a probe never
 * outlives the one after it.
 */
export const READY_TIMEOUT_MS = 3_000;

// Liveness and readiness are probed by infrastructure that holds no credentials.
@Controller()
@Public()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(): Promise<{ status: 'ok'; database: 'ok'; mail: 'smtp' | 'log' }> {
    try {
      // Raced, not merely awaited — see READY_TIMEOUT_MS. A rejection and a
      // timeout are the same answer to the only question a readiness probe
      // asks: can this instance serve a request that touches the database
      // right now?
      await withDeadline(this.db.execute(sql`select 1`), READY_TIMEOUT_MS);
    } catch {
      throw new ServiceUnavailableException('database unreachable');
    }
    // Reported, not asserted: `log` is a legitimate configuration for a
    // development stack and a broken one for production, and only an operator
    // looking at this can tell which they are running.
    return { status: 'ok', database: 'ok', mail: this.mailer.kind };
  }
}

/**
 * Resolves with `work`, or rejects once `ms` have passed — whichever happens
 * first.
 *
 * `unref()` on the timer so a pending deadline never holds the process open
 * during shutdown, and `clearTimeout` in the `finally` so a fast, healthy
 * probe leaves nothing behind on the event loop. The abandoned `work`
 * promise is *not* cancelled: there is nothing to cancel a query with here,
 * and its eventual settlement is harmless — the caller has already answered.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms`)), ms);
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

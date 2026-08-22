import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@duckoj/db';
import { DB } from '../config/config.module.js';
import { Public } from '../authn/auth.guard.js';
import { MAILER, type Mailer } from '../mail/mailer.js';

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
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException('database unreachable');
    }
    // Reported, not asserted: `log` is a legitimate configuration for a
    // development stack and a broken one for production, and only an operator
    // looking at this can tell which they are running.
    return { status: 'ok', database: 'ok', mail: this.mailer.kind };
  }
}

import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@duckoj/db';
import { DB } from '../config/config.module.js';
import { Public } from '../authn/auth.guard.js';

// Liveness and readiness are probed by infrastructure that holds no credentials.
@Controller()
@Public()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException('database unreachable');
    }
    return { status: 'ok', database: 'ok' };
  }
}

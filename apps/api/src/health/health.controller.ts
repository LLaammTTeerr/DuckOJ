import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@qhhoj/db';
import { DB } from '../config/config.module.js';

@Controller()
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

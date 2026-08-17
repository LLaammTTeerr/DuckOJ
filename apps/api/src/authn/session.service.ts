import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';
import { schema, type Db } from '@qhhoj/db';
import { APP_CONFIG, DB } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import type { Actor } from '../authz/actor.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issue(userId: number, meta: SessionMeta): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 3_600_000);
    await this.db.insert(schema.sessions).values({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<Actor | null> {
    const rows = await this.db
      .select({ userId: schema.users.id, globalRole: schema.users.globalRole })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(
        and(
          eq(schema.sessions.tokenHash, hashToken(token)),
          gt(schema.sessions.expiresAt, new Date()),
          eq(schema.users.status, 'active'),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? { userId: row.userId, globalRole: row.globalRole, via: 'session', scopes: [] } : null;
  }

  async revoke(token: string): Promise<void> {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
  }
}

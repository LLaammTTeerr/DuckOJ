import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import type { CreateTokenResponseDto, TokenSummaryDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import type { Actor } from '../authz/actor.js';
import { hashToken } from './session.service.js';

export const TOKEN_PREFIX = 'qhh_';

@Injectable()
export class TokenService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async issue(
    userId: number,
    name: string,
    scopes: string[],
    expiresAt?: Date,
  ): Promise<CreateTokenResponseDto> {
    const token = TOKEN_PREFIX + randomBytes(24).toString('base64url');
    const [row] = await this.db
      .insert(schema.accessTokens)
      .values({ userId, name, scopes, tokenHash: hashToken(token), expiresAt: expiresAt ?? null })
      .returning({ id: schema.accessTokens.id });
    return { id: row!.id, token };
  }

  async resolve(token: string): Promise<Actor | null> {
    const rows = await this.db
      .select({
        id: schema.accessTokens.id,
        userId: schema.users.id,
        globalRole: schema.users.globalRole,
        scopes: schema.accessTokens.scopes,
      })
      .from(schema.accessTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.accessTokens.userId))
      .where(
        and(
          eq(schema.accessTokens.tokenHash, hashToken(token)),
          or(isNull(schema.accessTokens.expiresAt), gt(schema.accessTokens.expiresAt, new Date())),
          eq(schema.users.status, 'active'),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    await this.db
      .update(schema.accessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.accessTokens.id, row.id));
    return { userId: row.userId, globalRole: row.globalRole, via: 'token', scopes: row.scopes };
  }

  async list(userId: number): Promise<TokenSummaryDto[]> {
    const rows = await this.db
      .select({
        id: schema.accessTokens.id,
        name: schema.accessTokens.name,
        scopes: schema.accessTokens.scopes,
        lastUsedAt: schema.accessTokens.lastUsedAt,
        expiresAt: schema.accessTokens.expiresAt,
        createdAt: schema.accessTokens.createdAt,
      })
      .from(schema.accessTokens)
      .where(eq(schema.accessTokens.userId, userId));

    // `timestamp` columns come back as `Date`; the contract's `Timestamp` is an
    // RFC 3339 string (same convention as `toMe()` in auth.service.ts).
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async revoke(userId: number, id: number): Promise<void> {
    await this.db
      .delete(schema.accessTokens)
      .where(and(eq(schema.accessTokens.id, id), eq(schema.accessTokens.userId, userId)));
  }
}

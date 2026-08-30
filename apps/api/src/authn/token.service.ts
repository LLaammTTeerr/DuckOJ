import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import type { CreateTokenResponseDto, TokenSummaryDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from '../authz/actor.js';
import { hashToken } from './session.service.js';

export const TOKEN_PREFIX = 'duck_';

/**
 * The one refusal D102 adds, in one place so the two halves cannot drift.
 *
 * The wording names the web deliberately. Every client that can reach this
 * refusal is a non-browser one — `oj`, the MCP server — so the reader is
 * looking at a terminal, and "409" alone tells them nothing about the fact
 * that the fix is three clicks away in a browser they are not looking at.
 */
export function passwordChangeRequired(): AppError {
  return new AppError(
    409,
    'password_change_required',
    'This account still holds the password it was issued. Change your password in the web ' +
      'interface first; access tokens are refused until you do.',
  );
}

@Injectable()
export class TokenService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Mints a token — unless the owner still carries `must_change_password`
   * (D102).
   *
   * The check lives HERE rather than in `TokensController` because the
   * controller is not the only way in: anything that later wants to mint a
   * token for a user has to pass through this method, and a rule written one
   * layer up is a rule the next caller can forget. D61 put the obligation on
   * the web because reaching the API around it meant "driving the API by
   * hand"; `oj login` and D89's MCP server are that, documented, so the
   * premise no longer holds and a session opened on a printed classroom
   * password could mint a credential that outlives the change.
   */
  async issue(
    userId: number,
    name: string,
    scopes: string[],
    expiresAt?: Date,
  ): Promise<CreateTokenResponseDto> {
    const [owner] = await this.db
      .select({ mustChangePassword: schema.users.mustChangePassword })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (owner?.mustChangePassword) throw passwordChangeRequired();
    const token = TOKEN_PREFIX + randomBytes(24).toString('base64url');
    const [row] = await this.db
      .insert(schema.accessTokens)
      .values({ userId, name, scopes, tokenHash: hashToken(token), expiresAt: expiresAt ?? null })
      .returning({ id: schema.accessTokens.id });
    return { id: row!.id, token };
  }

  /**
   * A token to an actor — or a refusal, if the owner is flagged (D102).
   *
   * With `issue` closed, no token can be minted while the flag is set, so
   * the only way to hold both is to have minted the token BEFORE the flag
   * (a token predating this rule, or an account re-imported under a name it
   * already had). That is a small population and a shrinking one, and it is
   * also exactly the population the mint check cannot reach: without this
   * half, a pupil who ran `oj login` once keeps a credential that the forced
   * change was supposed to have ended.
   *
   * Reads are refused as well as writes. A token is one credential, not two,
   * and splitting the refusal by HTTP method would mean every new write
   * route inheriting a rule from its verb — the shape the deny-by-default
   * guard exists to avoid. The session is untouched: it is how the change is
   * made.
   */
  async resolve(token: string): Promise<Actor | null> {
    const rows = await this.db
      .select({
        id: schema.accessTokens.id,
        userId: schema.users.id,
        globalRole: schema.users.globalRole,
        scopes: schema.accessTokens.scopes,
        mustChangePassword: schema.users.mustChangePassword,
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
    if (row.mustChangePassword) throw passwordChangeRequired();
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

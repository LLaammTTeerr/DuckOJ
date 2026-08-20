import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { organizations, orgMembers } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import type { OrgPageDto, OrgSummaryDto, PaginationQueryDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from './actor.js';
import { visibleOrgsWhere } from './org.visibility.js';

/**
 * The ONLY *service* permitted to import `@duckoj/db/guarded` for
 * organizations — with `org.visibility.ts` holding the shared visibility
 * condition and membership loader, exactly as `problem.visibility.ts` does
 * for problems. Every read of an organization anywhere in the API goes
 * through here, so visibility cannot be forgotten at a call site.
 */
@Injectable()
export class OrgAccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listVisible(
    actor: Actor | null,
    // `cursor?: string | undefined` rather than `cursor?: string`: the project
    // compiles with `exactOptionalPropertyTypes`, under which a parsed
    // `PaginationQueryDto` is not assignable to the narrower form.
    page: Pick<PaginationQueryDto, 'limit'> & { cursor?: string | undefined },
  ): Promise<OrgPageDto> {
    const after = parseCursor(page.cursor);
    const rows = await this.db
      .select()
      .from(organizations)
      .where(and(visibleOrgsWhere(this.db, actor), gt(organizations.id, after)))
      .orderBy(asc(organizations.id))
      .limit(page.limit + 1);

    const items = rows.slice(0, page.limit).map(toOrgSummary);
    const nextCursor = rows.length > page.limit ? String(items.at(-1)!.id) : null;
    return { items, nextCursor };
  }

  async getVisible(actor: Actor | null, slug: string): Promise<OrgSummaryDto> {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(
        and(visibleOrgsWhere(this.db, actor), sql`lower(${organizations.slug}) = lower(${slug})`),
      )
      .limit(1);

    // 404 rather than 403: a private organization must not disclose its existence.
    if (!rows[0]) {
      throw new AppError(404, 'organization_not_found', 'No such organization.');
    }
    return toOrgSummary(rows[0]);
  }

  async roleIn(actor: Actor | null, orgId: number): Promise<'owner' | 'admin' | 'member' | null> {
    if (!actor) return null;
    const rows = await this.db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, actor.userId)))
      .limit(1);
    return rows[0]?.role ?? null;
  }
}

/**
 * Cursors are opaque to clients but are ids here. A non-numeric cursor is a
 * client mistake, not a server fault: reject it as a validation problem rather
 * than letting `NaN` reach the driver and surface as a 500.
 */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const after = Number(cursor);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return after;
}

function toOrgSummary(row: typeof organizations.$inferSelect): OrgSummaryDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    about: row.about,
    visibility: row.visibility,
    joinPolicy: row.joinPolicy,
    createdAt: row.createdAt.toISOString(),
  };
}

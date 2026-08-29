/**
 * D14 — in-app notifications. One writer (`notify`, called by producers
 * inside their own flows) and one reader surface, always scoped
 * `user_id = actor`: there is no way to ask this service about anyone else.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import type { NotificationListDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import type { Actor } from '../authz/actor.js';

/** A feed, not an archive — the cap is the product decision. */
const FEED_LIMIT = 50;

@Injectable()
export class NotificationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Fire-and-forget from the producer's point of view, but *within* the
   * caller's transaction when one is passed: a decided join request whose
   * notification failed to write should roll back together, not diverge.
   */
  async notify(
    tx: Db,
    userId: number,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(schema.notifications).values({ userId, kind, payload });
  }

  /**
   * The same write, fanned out to many people in **one** statement.
   *
   * A contest announcement reaches every participant at once, and a loop of
   * two thousand single-row inserts inside the organiser's transaction is a
   * two-thousand-round-trip request holding a write lock on contest day.
   * Callers de-duplicate and cap the id list before calling — a person who
   * holds a live participation plus two virtual attempts is one recipient,
   * not three — because only the caller knows what its ids mean.
   *
   * A caller with nothing to say inserts nothing: `VALUES ()` is a syntax
   * error, not an empty write.
   */
  async notifyMany(
    tx: Db,
    userIds: number[],
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (userIds.length === 0) return;
    await tx.insert(schema.notifications).values(userIds.map((userId) => ({ userId, kind, payload })));
  }

  async listFor(actor: Actor): Promise<NotificationListDto> {
    const [items, unread] = await Promise.all([
      this.db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.userId, actor.userId))
        .orderBy(desc(schema.notifications.id))
        .limit(FEED_LIMIT),
      this.db
        .select({ n: count() })
        .from(schema.notifications)
        .where(
          and(eq(schema.notifications.userId, actor.userId), isNull(schema.notifications.readAt)),
        ),
    ]);
    return {
      items: items.map((row) => ({
        id: row.id,
        kind: row.kind,
        payload: row.payload as Record<string, unknown>,
        readAt: row.readAt === null ? null : row.readAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
      unreadCount: unread[0]?.n ?? 0,
    };
  }

  async markAllRead(actor: Actor): Promise<NotificationListDto> {
    await this.db
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(
        and(eq(schema.notifications.userId, actor.userId), isNull(schema.notifications.readAt)),
      );
    return this.listFor(actor);
  }
}

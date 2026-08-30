import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DRAFT_TTL_MS } from '@duckoj/contracts';
import { DRAFT_STORE, type DraftStore } from '../packages/draft.store.js';

/** How often expired draft directories are reclaimed. */
export const DRAFT_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * Deletes the directories of drafts nobody can reach any more (D87).
 *
 * This sweep reclaims DISK and nothing else — expiry itself is enforced on
 * every request, from `meta.createdAt`, by `isDraftExpired`. That split is
 * deliberate: a rule applied only here would keep accepting files into a dead
 * draft for up to an hour, and a sweep that also decided access would have to
 * run inside the request path.
 *
 * `ExpiredRowsSweeper`'s shape exactly — no sweep at boot (a test builds and
 * tears down an application per spec and must not have its fixture swept out
 * from under it), an `unref`'d timer so it never holds a process open, a
 * `clearInterval` on destroy so tests do not leak it, and a failure that is a
 * log line rather than an unhandled rejection. It runs in every worker; the
 * work is idempotent and a repeat costs one `readdir` that finds nothing.
 */
@Injectable()
export class DraftSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DraftSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(DRAFT_STORE) private readonly drafts: DraftStore) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweepQuietly(), DRAFT_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sweep(now: Date = new Date(), ttlMs: number = DRAFT_TTL_MS): Promise<number> {
    return this.drafts.sweep(now, ttlMs);
  }

  private async sweepQuietly(): Promise<void> {
    try {
      const removed = await this.sweep();
      if (removed > 0) this.logger.log(`swept ${String(removed)} expired package drafts`);
    } catch (error) {
      this.logger.warn(`draft sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

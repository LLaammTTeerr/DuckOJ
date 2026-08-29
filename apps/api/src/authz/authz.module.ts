import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PackagesModule } from '../packages/packages.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import {
  RedisSubmissionPublisher,
  SUBMISSION_PUBLISHER,
} from '../realtime/submission-publisher.js';
import { ContestAccessService } from './contest.access.js';
import { OrgAccessService } from './org.access.js';
import { ProblemAccessService } from './problem.access.js';
import { RatingService } from './rating.service.js';
import { RejudgeService } from './rejudge.access.js';
import {
  RedisScoreboardCacheStore,
  SCOREBOARD_CACHE_STORE,
  ScoreboardCache,
} from './scoreboard.cache.js';

@Module({
  // `PackagesModule` for `PACKAGE_STORE`, which `ProblemAccessService.attachRevision`
  // needs to read a package's manifest. `PackagesModule` imports `AuthnModule`,
  // not `AuthzModule`, so this stays acyclic — no `forwardRef` needed.
  imports: [ConfigModule, PackagesModule, NotificationsModule],
  providers: [
    ContestAccessService,
    OrgAccessService,
    ProblemAccessService,
    RatingService,
    RejudgeService,
    // The scoreboard cache (D25) and its Redis backing. Redis-backed rather
    // than a map in this process because `main.ts` forks `API_WORKERS`
    // workers, and an in-process cache is one cache per worker. Like the
    // publisher below it opens no connection until something reads or writes,
    // so every spec that never touches a scoreboard is unaffected.
    ScoreboardCache,
    { provide: SCOREBOARD_CACHE_STORE, useClass: RedisScoreboardCacheStore },
    // The API's own publisher on the realtime submissions channel, for
    // `RejudgeService` — the one write path that changes a submission's state
    // without a judge involved. Provided here rather than in `RealtimeModule`
    // because that module imports `SubmissionsModule`, and having it export a
    // provider back into `AuthzModule` would close a cycle. It opens no
    // connection until something actually publishes.
    { provide: SUBMISSION_PUBLISHER, useClass: RedisSubmissionPublisher },
  ],
  exports: [
    ContestAccessService,
    ScoreboardCache,
    OrgAccessService,
    ProblemAccessService,
    RatingService,
    RejudgeService,
  ],
})
export class AuthzModule {}

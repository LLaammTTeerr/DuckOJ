import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PackagesModule } from '../packages/packages.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import {
  RedisSubmissionPublisher,
  SUBMISSION_PUBLISHER,
} from '../realtime/submission-publisher.js';
import { CONTEST_PRESENCE, RedisContestPresence } from '../realtime/contest-presence.js';
import { RateLimiter } from '../common/rate-limiter.js';
import { ContestAccessService } from './contest.access.js';
import { ContestMonitorService } from './contest.monitor.js';
import { DashboardService, REDIS_HEALTH, RedisHealthProbe } from './dashboard.access.js';
import { ContestClarificationsService } from './contest.clarifications.js';
import {
  ContestSimilarityService,
  DEFAULT_SIMILARITY_BOUNDS,
  SIMILARITY_BOUNDS,
} from './contest.similarity.js';
import {
  DEFAULT_SIMILARITY_REAPER_BOUNDS,
  SIMILARITY_REAPER_BOUNDS,
  SimilarityRunReaper,
} from './similarity.reaper.js';
import { OrgAccessService } from './org.access.js';
import { OrgImportService } from './org.import.js';
import { ProblemAccessService } from './problem.access.js';
import { ProblemCommentsService } from './problem.comments.js';
import { ProgressService } from './progress.access.js';
import {
  DEFAULT_PROGRESS_EXPORT_BOUNDS,
  PROGRESS_EXPORT_BOUNDS,
  ProblemSetAccessService,
} from './problem-set.access.js';
import { RatingService } from './rating.service.js';
import { TeamAccessService } from './team.access.js';
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
    ContestClarificationsService,
    // The organiser live monitor (D95). Here rather than beside the contests
    // controller for `ContestClarificationsService`'s reason: it reads six
    // guarded tables and decides no visibility of its own — it asks
    // `ContestAccessService.loadVisible` and `canRunContest`.
    ContestMonitorService,
    // The source-similarity reports (D77). Here rather than beside the
    // contests controller, on `ContestClarificationsService`'s precedent:
    // it reads five guarded tables and writes a sixth, which the runbook
    // confines to `authz/**`. It decides no visibility of its own — it asks
    // `ContestAccessService` and `canRunContest`, exactly as the results
    // exports do.
    ContestSimilarityService,
    // The two caps, injected so a test can meet them at three participants
    // rather than three thousand (`PROGRESS_EXPORT_BOUNDS`' precedent).
    { provide: SIMILARITY_BOUNDS, useValue: DEFAULT_SIMILARITY_BOUNDS },
    // The reaper for runs whose process died mid-comparison (D83). A
    // provider rather than a method on the service above, on
    // `ExpiredRowsSweeper`'s precedent: it owns a timer and a lifecycle,
    // which is a different kind of object from a request-scoped read.
    SimilarityRunReaper,
    { provide: SIMILARITY_REAPER_BOUNDS, useValue: DEFAULT_SIMILARITY_REAPER_BOUNDS },
    // `RateLimiter` is stateless — it counts rows in `rate_events` — so
    // providing it here rather than importing `AuthnModule` (which would
    // close a cycle: `AuthnModule` is imported by every controller module
    // that also imports this one) costs nothing but a second instance.
    RateLimiter,
    OrgAccessService,
    // D61's roster import. A provider of its own rather than more methods on
    // `OrgAccessService`: it needs the rate limiter and the notifier, neither
    // of which anything else in that class touches, and its rule lives in a
    // framework-free module the CLI also runs.
    OrgImportService,
    ProblemAccessService,
    ProblemCommentsService,
    // D66's classroom problem sets. Its own provider rather than more
    // methods on `OrgAccessService`: it asks that service who may act, and
    // reads three tables that service never touches.
    ProblemSetAccessService,
    // How far the homework CSV walks before it stops and says so — injected
    // so the cap is reachable in a test at three rows rather than twenty
    // thousand (`MAX_SUBSCRIPTIONS`'s precedent).
    { provide: PROGRESS_EXPORT_BOUNDS, useValue: DEFAULT_PROGRESS_EXPORT_BOUNDS },
    // The student progress page (D83). In `authz/` for `UserAccessService`'s
    // reason: it filters on `problems.visibility` and reads six guarded
    // tables. It needs `ScoreboardCache` for its 60 s per-user entry.
    ProgressService,
    RatingService,
    RejudgeService,
    // D99's teams. Its own provider rather than more methods on
    // `OrgAccessService`, on `ProblemSetAccessService`'s precedent: it asks
    // that service who may act, and reads two tables that service never
    // touches.
    TeamAccessService,
    // The admin operations dashboard (D47). It lives here, not in
    // `AdminModule`, because two of its panels read guarded tables — the
    // same rule that put `RejudgeService` here. Its Redis probe opens no
    // connection until somebody actually loads the dashboard.
    DashboardService,
    { provide: REDIS_HEALTH, useClass: RedisHealthProbe },
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
    // Who holds a live socket, shared across workers through Redis (D95).
    // Provided here, and exported, for the publisher's reason turned around:
    // `RealtimeModule` is the one that WRITES it and `ContestMonitorService`
    // is the one that reads it, and having the realtime module export a
    // provider back into this one would close a cycle. It opens no connection
    // until a socket is accepted or a monitor is opened.
    { provide: CONTEST_PRESENCE, useClass: RedisContestPresence },
  ],
  exports: [
    ContestAccessService,
    ContestClarificationsService,
    ContestMonitorService,
    CONTEST_PRESENCE,
    // The organiser live monitor (D95). Here rather than beside the contests
    // controller for `ContestClarificationsService`'s reason: it reads six
    // guarded tables and decides no visibility of its own — it asks
    // `ContestAccessService.loadVisible` and `canRunContest`.
    ContestMonitorService,
    ContestSimilarityService,
    DashboardService,
    ScoreboardCache,
    OrgAccessService,
    OrgImportService,
    ProblemAccessService,
    ProblemCommentsService,
    ProblemSetAccessService,
    ProgressService,
    RatingService,
    RejudgeService,
    TeamAccessService,
  ],
})
export class AuthzModule {}

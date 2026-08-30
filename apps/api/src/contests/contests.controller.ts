import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AnswerClarificationRequest,
  AskClarificationRequest,
  BookletQuery,
  CertificatesQuery,
  CloneContestRequest,
  ContestListQuery,
  CreateContestRequest,
  JoinContestRequest,
  PostAnnouncementRequest,
  RunSimilarityRequest,
  SeedParticipantRequest,
  SetDisqualifiedRequest,
  SimilarityPairQuery,
  UpdateContestRequest,
  type AnswerClarificationRequestDto,
  type AskClarificationRequestDto,
  type BookletQueryDto,
  type CertificatesQueryDto,
  type ClarificationDto,
  type CloneContestRequestDto,
  type ClarificationListDto,
  type ContestDetailDto,
  type ContestParticipationDto,
  type ContestListQueryDto,
  ContestMonitorQuery,
  type ContestMonitorDto,
  type ContestMonitorQueryDto,
  type ContestPageDto,
  type CreateContestRequestDto,
  type JoinContestRequestDto,
  type PostAnnouncementRequestDto,
  type RunSimilarityRequestDto,
  type ScoreboardDto,
  type SeedParticipantRequestDto,
  type SetDisqualifiedRequestDto,
  type SimilarityPairQueryDto,
  type SimilarityPairViewDto,
  type SimilarityReportDto,
  type SimilarityRunDto,
  type UpdateContestRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor, MaybeActor, Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { ContestAccessService } from '../authz/contest.access.js';
import { ContestClarificationsService } from '../authz/contest.clarifications.js';
import { ContestMonitorService } from '../authz/contest.monitor.js';
import { ContestSimilarityService } from '../authz/contest.similarity.js';
import { ScoreboardCache } from '../authz/scoreboard.cache.js';
import { STATEMENT_RENDERER, type StatementRenderer } from '../statements/statement-renderer.js';
import { BOOKLET_CACHE_TTL_MS, bookletCacheKey } from '../statements/booklet.cache.js';
import {
  RESULTS_CACHE_TTL_MS,
  certificatesCacheKey,
  resultsCacheKey,
} from '../statements/results.cache.js';
import { ContestResultsService } from './results.service.js';

/**
 * Anonymous callers are served on every `GET` here deliberately — they see
 * public contests only, and a contest they may not see 404s rather than 403s.
 * What each actor may see is decided entirely in `ContestAccessService`,
 * never in this controller. Mirrors `ProblemsController` throughout.
 *
 * Joining a contest, and routing a live submission into one, are deliberately
 * absent (design §4): this phase seeds participations directly, exactly as the
 * golden replay does.
 */
@Controller('contests')
export class ContestsController {
  constructor(
    @Inject(ContestAccessService) private readonly contests: ContestAccessService,
    @Inject(ContestClarificationsService)
    private readonly clarifications: ContestClarificationsService,
    @Inject(STATEMENT_RENDERER) private readonly statements: StatementRenderer,
    @Inject(ScoreboardCache) private readonly cache: ScoreboardCache,
    @Inject(ContestResultsService) private readonly results: ContestResultsService,
    @Inject(ContestSimilarityService) private readonly similarity: ContestSimilarityService,
    @Inject(ContestMonitorService) private readonly monitor: ContestMonitorService,
  ) {}

  // `@Public()` is marked per handler, never on the class: `Public()` only
  // ever sets true, so a class-level marker is a one-way door that would
  // silently hand anonymous access to the next handler added here.
  @Get()
  @Public()
  @RequireScope('contests:read')
  list(
    @MaybeActor() actor: Actor | null,
    @Query(new ZodValidationPipe(ContestListQuery)) query: ContestListQueryDto,
  ): Promise<ContestPageDto> {
    return this.contests.listVisible(actor, {
      cursor: query.cursor,
      limit: query.limit,
      org: query.org,
    });
  }

  @Get(':key')
  @Public()
  @RequireScope('contests:read')
  get(@MaybeActor() actor: Actor | null, @Param('key') key: string): Promise<ContestDetailDto> {
    return this.contests.getVisible(actor, key);
  }

  /**
   * The scoreboard, in the goldens' snake_case — see `ScoreboardDto`. Served
   * under `contests:read`, not a scope of its own: a caller who may see the
   * contest may see how it stands.
   */
  @Get(':key/scoreboard')
  @Public()
  @RequireScope('contests:read')
  async scoreboard(
    @MaybeActor() actor: Actor | null,
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ScoreboardDto> {
    const { board, cache } = await this.contests.getScoreboardCached(actor, key);
    // A HEADER, never a body field (D25). The body is the goldens'
    // snake_case shape and 23 golden replays compare it byte for byte; a
    // `cache` key in there would be DuckOJ inventing a field inside a shape
    // frozen from DMOJ, and every client would have to learn to ignore it.
    // Operators and load tests read a header perfectly well.
    res.setHeader('X-Scoreboard-Cache', cache);
    return board;
  }

  /**
   * Every problem of the contest as one printable PDF (D48).
   *
   * **Visibility before capability**, exactly as `GET
   * /problems/{code}/statement.pdf` orders it: `getBookletDocument` decides
   * who may see this contest's problem list — and 404s a contest that has
   * not started for anyone who does not run it — BEFORE the renderer is
   * asked for anything, so a server with no typst configured cannot answer
   * 501 for a contest whose existence it should be concealing.
   *
   * `contests:read`, not a scope of its own: a caller who may read the
   * contest's problems may read them on paper.
   */
  @Get(':key/booklet.pdf')
  @Public()
  @RequireScope('contests:read')
  async booklet(
    @MaybeActor() actor: Actor | null,
    @Param('key') key: string,
    @Query(new ZodValidationPipe(BookletQuery)) query: BookletQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { contestId, document } = await this.contests.getBookletDocument(actor, key, query.lang);
    // Base64 through a JSON cache whose store speaks strings. A PDF is the
    // one thing in this app that is not text, and teaching the store about
    // buffers to save a third of a megabyte per contest per minute would
    // buy a second serialization path for every cached thing in the app.
    const { value, cache } = await this.cache.through(
      bookletCacheKey(contestId, query.lang, document),
      async () => ({ pdf: (await this.statements.renderDocument(document)).toString('base64') }),
      BOOKLET_CACHE_TTL_MS,
    );
    // A HEADER, never a body field — there is no body to put it in, and it
    // is D25's precedent either way.
    res.setHeader('X-Booklet-Cache', cache);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${key}.pdf"`);
    return new StreamableFile(Buffer.from(value.pdf, 'base64'));
  }

  /**
   * The contest's final standings as a spreadsheet (D71).
   *
   * **No `@Public()`**, unlike every other contest `GET` here: the export is
   * the live, unfrozen board, so an anonymous caller has no business
   * reaching the handler at all. `contests:read`, matching `GET
   * /contests/{key}/me` — the other read on this controller that is about
   * who is asking — and who may actually export is `ContestResultsService`'s
   * call, never this controller's.
   *
   * Deliberately NOT routed through the renderer or its cache: a CSV is a
   * few kilobytes of string built from an already-cached board, and sharing
   * a handler with the PDFs would make this route answer 501 on a server
   * with no typst — for a file that needs none.
   */
  @Get(':key/results.csv')
  @RequireScope('contests:read')
  async resultsCsv(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { contestKey, csv } = await this.results.resultsCsv(actor, key);
    // `charset=utf-8` beside the BOM, not instead of it: the header is what
    // a browser and `curl` read, the BOM is the only thing Excel reads.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // `attachment`, not `inline`: a spreadsheet is a file to open in Excel,
    // and a browser rendering it as text is nobody's intention. The stored
    // key is used rather than the URL's, so the filename cannot carry
    // anything `CONTEST_KEY` does not allow.
    res.setHeader('Content-Disposition', `attachment; filename="${contestKey}-results.csv"`);
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }

  /**
   * The same standings, typeset for the wall (D71).
   *
   * Authorization before capability, exactly as the booklet orders it: a
   * caller who does not run the contest is refused BEFORE the renderer is
   * asked for anything, so a server with no typst cannot answer 501 to
   * somebody who was never entitled to the document.
   */
  @Get(':key/results.pdf')
  @RequireScope('contests:read')
  async resultsPdf(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { contestId, contestKey, document } = await this.results.standingsDocument(actor, key);
    const { value, cache } = await this.cache.through(
      resultsCacheKey(contestId, document),
      async () => ({ pdf: (await this.statements.renderDocument(document)).toString('base64') }),
      RESULTS_CACHE_TTL_MS,
    );
    res.setHeader('X-Results-Cache', cache);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${contestKey}-results.pdf"`);
    return new StreamableFile(Buffer.from(value.pdf, 'base64'));
  }

  /**
   * One certificate per participant (D71).
   *
   * The selection lives in the DOCUMENT, so the content-addressed cache key
   * separates `?top=3` from `?top=10` with no scope of its own — the same
   * property the booklet's key relies on for `?lang=`.
   */
  @Get(':key/certificates.pdf')
  @RequireScope('contests:read')
  async certificatesPdf(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Query(new ZodValidationPipe(CertificatesQuery)) query: CertificatesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { contestId, contestKey, document } = await this.results.certificatesDocument(
      actor,
      key,
      query,
    );
    const { value, cache } = await this.cache.through(
      certificatesCacheKey(contestId, document),
      async () => ({ pdf: (await this.statements.renderDocument(document)).toString('base64') }),
      RESULTS_CACHE_TTL_MS,
    );
    res.setHeader('X-Certificates-Cache', cache);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${contestKey}-certificates.pdf"`);
    return new StreamableFile(Buffer.from(value.pdf, 'base64'));
  }

  /**
   * The organiser live monitor (D95).
   *
   * **No `@Public()`**, on `similarityReport`'s reasoning: an anonymous caller
   * has no business reaching a handler that reports, unfrozen, what every
   * competitor in a running contest has just submitted. `contests:read`,
   * because it is a read; who may actually ask is `ContestMonitorService`'s
   * call, never this controller's — 404 for a contest the caller may not see,
   * 403 `contest_forbidden` for one they can see but do not run.
   *
   * `?recompute=1` rebuilds this contest's per-problem counters before
   * answering (D100). It stays a GET on this route rather than becoming a
   * POST of its own: it is idempotent, it changes nothing an observer can
   * see except making a number correct, and the person who needs it is
   * already looking at the panel that is wrong. `contests:read` for the same
   * reason — the write it performs is a repair of a cache, not a decision
   * about the contest.
   */
  @Get(':key/monitor')
  @RequireScope('contests:read')
  contestMonitor(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Query(new ZodValidationPipe(ContestMonitorQuery)) query: ContestMonitorQueryDto,
  ): Promise<ContestMonitorDto> {
    return this.monitor.snapshot(actor, key, query);
  }

  /**
   * Start a source-similarity check over this contest (D77).
   *
   * `contests:write`, matching every other organiser action here rather than
   * a scope of its own: running a contest you created is the same authority
   * as creating it. **No `@Public()`** — this writes a row and starts work.
   *
   * The handler returns as soon as the run row is committed; the comparing
   * happens in this process behind a per-contest advisory lock, and `GET`
   * is how an organiser learns it finished. Who may actually ask is
   * `ContestSimilarityService`'s call, never this controller's.
   */
  @Post(':key/similarity')
  @HttpCode(201)
  @RequireScope('contests:write')
  runSimilarity(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(RunSimilarityRequest)) body: RunSimilarityRequestDto,
  ): Promise<SimilarityRunDto> {
    return this.similarity.start(actor, key, body.threshold);
  }

  /**
   * The latest similarity run and its pairs (D77).
   *
   * **No `@Public()`**, unlike the contest reads above and for the same
   * reason `results.csv` has none: an anonymous caller has no business
   * reaching a handler whose whole output is a list of people suspected of
   * copying. `contests:read`, because it is a read.
   */
  @Get(':key/similarity')
  @RequireScope('contests:read')
  similarityReport(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
  ): Promise<SimilarityReportDto> {
    return this.similarity.latest(actor, key);
  }

  /**
   * Two matched submissions side by side, with the matched spans (D77).
   *
   * The one route in the product that serves another person's contest source
   * to somebody who is not its author. D27 withholds it from everyone; D77
   * records why the people RUNNING the contest are not covered by that
   * clause — they can already read every submission made into it, one at a
   * time. The pair must be one the latest run reported, so this cannot
   * become "show me any two competitors' code".
   */
  @Get(':key/similarity/:a/:b')
  @RequireScope('contests:read')
  similarityPair(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Param('a') a: string,
    @Param('b') b: string,
    @Query(new ZodValidationPipe(SimilarityPairQuery)) query: SimilarityPairQueryDto,
  ): Promise<SimilarityPairViewDto> {
    return this.similarity.pairView(actor, key, a, b, query.problem);
  }

  /**
   * Join. Under `contests:write` rather than a scope of its own: a token that
   * may create a contest may certainly enter one, and splitting out a
   * narrower `contests:participate` later widens what an existing token is
   * accepted for, which is backwards compatible. Starting narrow and widening
   * is not.
   */
  /**
   * Join. The body is optional — an individual contest is entered with none,
   * which is what every client written before D99 sends — and names a
   * `teamSlug` in a team contest.
   */
  @Post(':key/join')
  @HttpCode(201)
  @RequireScope('contests:write')
  join(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(JoinContestRequest)) body: JoinContestRequestDto,
  ): Promise<ContestParticipationDto> {
    return this.contests.join(actor, key, body);
  }

  /** The caller's own participation. Never public: it is about the caller. */
  @Get(':key/me')
  @RequireScope('contests:read')
  me(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
  ): Promise<ContestParticipationDto> {
    return this.contests.myParticipation(actor, key);
  }

  /**
   * Edit a contest. `contests:write`, like every other write here; who may
   * actually do it is `ContestAccessService`'s call, not this controller's.
   */
  @Patch(':key')
  @RequireScope('contests:write')
  update(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateContestRequest)) body: UpdateContestRequestDto,
  ): Promise<ContestDetailDto> {
    return this.contests.update(actor, key, body);
  }

  /**
   * Disqualify, or reinstate, a participant.
   *
   * `contests:write`, matching `create` and `join` rather than a scope of its
   * own: running a contest you created is the same authority as creating it.
   * Who may actually do it is decided in `ContestAccessService`, as
   * everywhere else in this controller.
   */
  /**
   * Enter a team into this contest, as its organiser (D99 amended).
   *
   * `contests:write`, matching `join` and the disqualify control beside it:
   * running a contest you created is the same authority as creating it. Who
   * may actually do it is `ContestAccessService`'s call, as everywhere else
   * here — 404 for a contest the caller may not see, 403 for one they can see
   * but do not run.
   *
   * `POST` on the collection, not a verb: it creates a participation, and 201
   * is what creating one means.
   */
  @Post(':key/participants')
  @HttpCode(201)
  @RequireScope('contests:write')
  seedParticipant(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(SeedParticipantRequest)) body: SeedParticipantRequestDto,
  ): Promise<ContestParticipationDto> {
    return this.contests.seedParticipant(actor, key, body.teamSlug);
  }

  @Patch(':key/participants/:username')
  @RequireScope('contests:write')
  setDisqualified(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Param('username') username: string,
    @Body(new ZodValidationPipe(SetDisqualifiedRequest)) body: SetDisqualifiedRequestDto,
  ): Promise<ContestParticipationDto> {
    return this.contests.setDisqualified(actor, key, username, body.disqualified);
  }

  /**
   * Ask the organisers a question (D31).
   *
   * `@RequireScope('contests:write')`, exactly as `join` is marked and for
   * the same reason: a token that may enter a contest may certainly ask
   * about the contest it entered, and minting a narrower
   * `contests:clarify` later would widen what an existing token is accepted
   * for, which is backwards compatible — starting narrow is not.
   */
  @Post(':key/clarifications')
  @HttpCode(201)
  @RequireScope('contests:write')
  ask(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(AskClarificationRequest)) body: AskClarificationRequestDto,
  ): Promise<ClarificationDto> {
    return this.clarifications.ask(actor, key, body);
  }

  /**
   * The clarification feed. `@Public()` like every other contest `GET`: an
   * announcement is for the people watching as much as the people
   * competing, and an anonymous caller sees the public rows only. Who sees
   * what is `ContestClarificationsService`'s call, never this controller's.
   */
  @Get(':key/clarifications')
  @Public()
  @RequireScope('contests:read')
  listClarifications(
    @MaybeActor() actor: Actor | null,
    @Param('key') key: string,
  ): Promise<ClarificationListDto> {
    return this.clarifications.list(actor, key);
  }

  /** Answer a clarification, or publish it — the contest creator or an admin. */
  @Patch(':key/clarifications/:id')
  @RequireScope('contests:write')
  answerClarification(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AnswerClarificationRequest)) body: AnswerClarificationRequestDto,
  ): Promise<ClarificationDto> {
    return this.clarifications.answer(actor, key, Number(id), body);
  }

  /** Post a public announcement — the contest creator or an admin. */
  @Post(':key/announcements')
  @HttpCode(201)
  @RequireScope('contests:write')
  announce(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(PostAnnouncementRequest)) body: PostAnnouncementRequestDto,
  ): Promise<ClarificationDto> {
    return this.clarifications.announce(actor, key, body);
  }

  /**
   * D88's clone. `contests:write`, like every other organiser action here —
   * this is a contest being created by someone the server has already shown
   * runs the source, not a new class of permission.
   */
  @Post(':key/clone')
  @HttpCode(201)
  @RequireScope('contests:write')
  clone(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(CloneContestRequest)) body: CloneContestRequestDto,
  ): Promise<ContestDetailDto> {
    return this.contests.clone(actor, key, body);
  }

  // Deliberately no @Public(): every write requires authentication at the
  // guard level, before this controller (or the service) ever sees it.
  @Post()
  @HttpCode(201)
  @RequireScope('contests:write')
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(CreateContestRequest)) body: CreateContestRequestDto,
  ): Promise<ContestDetailDto> {
    return this.contests.create(actor, body);
  }
}

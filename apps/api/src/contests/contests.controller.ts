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
  ContestListQuery,
  CreateContestRequest,
  PostAnnouncementRequest,
  SetDisqualifiedRequest,
  UpdateContestRequest,
  type AnswerClarificationRequestDto,
  type AskClarificationRequestDto,
  type BookletQueryDto,
  type ClarificationDto,
  type ClarificationListDto,
  type ContestDetailDto,
  type ContestParticipationDto,
  type ContestListQueryDto,
  type ContestPageDto,
  type CreateContestRequestDto,
  type PostAnnouncementRequestDto,
  type ScoreboardDto,
  type SetDisqualifiedRequestDto,
  type UpdateContestRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor, MaybeActor, Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { ContestAccessService } from '../authz/contest.access.js';
import { ContestClarificationsService } from '../authz/contest.clarifications.js';
import { ScoreboardCache } from '../authz/scoreboard.cache.js';
import { STATEMENT_RENDERER, type StatementRenderer } from '../statements/statement-renderer.js';
import { BOOKLET_CACHE_TTL_MS, bookletCacheKey } from '../statements/booklet.cache.js';

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
   * Join. Under `contests:write` rather than a scope of its own: a token that
   * may create a contest may certainly enter one, and splitting out a
   * narrower `contests:participate` later widens what an existing token is
   * accepted for, which is backwards compatible. Starting narrow and widening
   * is not.
   */
  @Post(':key/join')
  @HttpCode(201)
  @RequireScope('contests:write')
  join(
    @CurrentActor() actor: Actor,
    @Param('key') key: string,
  ): Promise<ContestParticipationDto> {
    return this.contests.join(actor, key);
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

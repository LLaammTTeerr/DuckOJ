import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
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
  AttachRevisionRequest,
  CreateProblemRequest,
  ProblemListQuery,
  RevisionVersionParam,
  UpdateProblemRequest,
  type AttachRevisionRequestDto,
  type CreateProblemRequestDto,
  type ProblemDetailDto,
  type ProblemListQueryDto,
  type ProblemPageDto,
  type RevisionSummaryDto,
  type RevisionVersionResponseDto,
  type UpdateProblemRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { AppError } from '../common/app.error.js';
import { CurrentActor, MaybeActor, Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { ProblemAccessService } from '../authz/problem.access.js';
import { STATEMENT_RENDERER, type StatementRenderer } from '../statements/statement-renderer.js';

/**
 * `UpdateProblemRequest` is `.strict()`, so a stray `code` key surfaces from
 * zod as a generic `unrecognized_keys` issue — the same 422 `validation_failed`
 * any other unrecognized key would produce, and indistinguishable from one at
 * that layer. This special-cases exactly `code`, ahead of the schema, into the
 * 400 `problem_code_immutable` the spec names — no other key gets this
 * treatment, so a genuine typo still falls through to `ZodValidationPipe` and
 * its ordinary 422.
 */
class UpdateProblemBodyPipe implements PipeTransform<unknown, UpdateProblemRequestDto> {
  private readonly inner = new ZodValidationPipe(UpdateProblemRequest);

  transform(value: unknown, metadata: ArgumentMetadata): UpdateProblemRequestDto {
    if (typeof value === 'object' && value !== null && 'code' in value) {
      throw new AppError(400, 'problem_code_immutable', "A problem's code cannot be changed.");
    }
    return this.inner.transform(value, metadata);
  }
}

/**
 * Anonymous callers are served on every `GET` here deliberately — what each
 * actor may see (or edit) is decided entirely in `ProblemAccessService`,
 * never in this controller. Every handler is a one-line delegation to it.
 */
@Controller('problems')
export class ProblemsController {
  constructor(
    @Inject(ProblemAccessService) private readonly problems: ProblemAccessService,
    @Inject(STATEMENT_RENDERER) private readonly statements: StatementRenderer,
  ) {}

  // `@Public()` is marked per handler, never on the class: `Public()` only
  // ever sets true, so a class-level marker is a one-way door that would
  // silently hand anonymous access to the next handler added here.
  @Get()
  @Public()
  @RequireScope('problems:read')
  list(
    @MaybeActor() actor: Actor | null,
    @Query(new ZodValidationPipe(ProblemListQuery)) query: ProblemListQueryDto,
  ): Promise<ProblemPageDto> {
    return this.problems.listVisible(actor, { cursor: query.cursor, limit: query.limit }, query.q);
  }

  @Get(':code')
  @Public()
  @RequireScope('problems:read')
  get(@MaybeActor() actor: Actor | null, @Param('code') code: string): Promise<ProblemDetailDto> {
    return this.problems.getVisible(actor, code);
  }

  /**
   * The statement as a printable PDF. Visibility is exactly `GET
   * /problems/:code` — the render happens *after* `getVisible`, so a
   * hidden problem 404s here identically, and a server with no typst
   * configured answers 501 without leaking whether the problem exists...
   * which would be a hole, so the visibility check deliberately runs
   * FIRST: 404 for a problem you may not see, 501 only for one you may.
   */
  @Get(':code/statement.pdf')
  @Public()
  @RequireScope('problems:read')
  async statementPdf(
    @MaybeActor() actor: Actor | null,
    @Param('code') code: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const problem = await this.problems.getVisible(actor, code);
    const pdf = await this.statements.render(problem.name, problem.statement);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${code}.pdf"`);
    return new StreamableFile(pdf);
  }

  // `@Public()` stays: `canViewRevisions` already 404s an anonymous caller
  // (spec §3, item 2 — a read never 403s, it 404s), and removing the marker
  // would replace that 404 with a guard-level 401 for the same caller — a
  // behaviour change this task does not authorize. `problems:publish`, not
  // `problems:read`, per spec §2.3: this lists draft/archived revisions
  // alongside the write endpoints below, not the published statement.
  @Get(':code/revisions')
  @Public()
  @RequireScope('problems:publish')
  listRevisions(@MaybeActor() actor: Actor | null, @Param('code') code: string): Promise<RevisionSummaryDto[]> {
    return this.problems.listRevisions(actor, code);
  }

  // Deliberately no @Public() on anything below: every write requires
  // authentication at the guard level, before this controller (or the
  // service) ever sees the request.
  @Post()
  @HttpCode(201)
  @RequireScope('problems:write')
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(CreateProblemRequest)) body: CreateProblemRequestDto,
  ): Promise<ProblemDetailDto> {
    return this.problems.create(actor, body);
  }

  @Patch(':code')
  @RequireScope('problems:write')
  update(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Body(new UpdateProblemBodyPipe()) body: UpdateProblemRequestDto,
  ): Promise<ProblemDetailDto> {
    return this.problems.update(actor, code, body);
  }

  @Post(':code/revisions')
  @HttpCode(201)
  @RequireScope('problems:publish')
  attachRevision(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Body(new ZodValidationPipe(AttachRevisionRequest)) body: AttachRevisionRequestDto,
  ): Promise<RevisionVersionResponseDto> {
    return this.problems.attachRevision(actor, code, body);
  }

  @Post(':code/revisions/:version/publish')
  @HttpCode(200)
  @RequireScope('problems:publish')
  publishRevision(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Param('version', new ZodValidationPipe(RevisionVersionParam)) version: number,
  ): Promise<RevisionVersionResponseDto> {
    return this.problems.publishRevision(actor, code, version);
  }
}

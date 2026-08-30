import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CreateProblemSetRequest,
  PaginationQuery,
  ProblemSetProgressQuery,
  UpdateProblemSetRequest,
  type CreateProblemSetRequestDto,
  type PaginationQueryDto,
  type ProblemSetDetailDto,
  type ProblemSetPageDto,
  type ProblemSetProgressDto,
  type ProblemSetProgressQueryDto,
  type UpdateProblemSetRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { ProblemSetAccessService, progressCsv } from '../authz/problem-set.access.js';

/**
 * Classroom problem sets (D66) — homework, under `/orgs/{slug}/sets`.
 *
 * A controller of its own rather than more handlers on `OrgsController`,
 * sharing its `orgs` prefix and its `Organizations` tag: this is one feature
 * with six routes and its own service, and `OrgsController` is already the
 * longest one in the app.
 *
 * **Nothing here is `@Public()`**, unlike every `GET` next door: a set is
 * assigned to a school's members, so an anonymous reader has no question to
 * ask. That also keeps the web app from firing a request that can only 401 —
 * `smoke.spec.ts`'s `watchForBrokenRequests` whitelists no such path.
 */
@Controller('orgs')
export class ProblemSetsController {
  constructor(@Inject(ProblemSetAccessService) private readonly sets: ProblemSetAccessService) {}

  @Get(':slug/sets')
  @RequireScope('orgs:read')
  list(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(PaginationQuery)) query: PaginationQueryDto,
  ): Promise<ProblemSetPageDto> {
    return this.sets.list(actor, slug, query);
  }

  @Get(':slug/sets/:setSlug')
  @RequireScope('orgs:read')
  get(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('setSlug') setSlug: string,
  ): Promise<ProblemSetDetailDto> {
    return this.sets.get(actor, slug, setSlug);
  }

  /**
   * The grid, as JSON or as a spreadsheet.
   *
   * The format decision lives here and the rule lives in the service: the
   * service answers ONE object either way (the CSV branch simply asks for
   * the whole roster rather than a page), so the two representations cannot
   * come to disagree about what a cell holds.
   *
   * `Content-Disposition: attachment` — this is a file for a filing cabinet,
   * not a page to read in a tab.
   */
  @Get(':slug/sets/:setSlug/progress')
  @RequireScope('orgs:read')
  async progress(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('setSlug') setSlug: string,
    @Query(new ZodValidationPipe(ProblemSetProgressQuery)) query: ProblemSetProgressQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProblemSetProgressDto | string> {
    const grid = await this.sets.progress(actor, slug, setSlug, query);
    if (query.format !== 'csv') return grid;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-${setSlug}.csv"`);
    return progressCsv(grid);
  }

  @Post(':slug/sets')
  @HttpCode(201)
  @RequireScope('orgs:write')
  create(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(CreateProblemSetRequest)) body: CreateProblemSetRequestDto,
  ): Promise<ProblemSetDetailDto> {
    return this.sets.create(actor, slug, body);
  }

  @Patch(':slug/sets/:setSlug')
  @RequireScope('orgs:write')
  update(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('setSlug') setSlug: string,
    @Body(new ZodValidationPipe(UpdateProblemSetRequest)) body: UpdateProblemSetRequestDto,
  ): Promise<ProblemSetDetailDto> {
    return this.sets.update(actor, slug, setSlug, body);
  }

  @Delete(':slug/sets/:setSlug')
  @HttpCode(204)
  @RequireScope('orgs:write')
  remove(
    @CurrentActor() actor: Actor,
    @Param('slug') slug: string,
    @Param('setSlug') setSlug: string,
  ): Promise<void> {
    return this.sets.remove(actor, slug, setSlug);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  BuildDraftRequest,
  DraftFileName,
  DraftId,
  type BuildDraftRequestDto,
  type BuildDraftResponseDto,
  type CreateDraftFromRevisionResponseDto,
  type CreateDraftResponseDto,
  type DraftFileResponseDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { readRawBody } from '../common/raw-body.js';
import { CurrentActor } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import type { Actor } from '../authz/actor.js';
import { ProblemDraftsService } from './problem-drafts.service.js';

/**
 * D87's browser-authoring routes, on their own controller under the same
 * `problems` prefix as `ProblemsController`.
 *
 * Deliberately no `@Public()` anywhere: every route here is a write against a
 * problem, and the deny-by-default guard refuses an unauthenticated caller
 * before this class is reached. `problems:publish`, the scope its
 * `POST /problems/{code}/revisions` neighbour carries and not
 * `problems:write`: a draft exists to become a revision, and a token allowed
 * to edit a statement but not to touch what grades submissions must not get
 * there through this door.
 *
 * `packages:write` is deliberately NOT also required for the build. The
 * package a build stores is not a package the caller chose the bytes of — it
 * is derived, server-side, from files this same actor was already permitted
 * to place, and demanding a second scope would mean a setter token minted for
 * problem authoring could open a draft, fill it, and then be refused at the
 * last step for a permission the flow never told it to ask for.
 */
@Controller('problems')
export class ProblemDraftsController {
  constructor(
    @Inject(ProblemDraftsService) private readonly drafts: ProblemDraftsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post(':code/drafts')
  @HttpCode(201)
  @RequireScope('problems:publish')
  create(@CurrentActor() actor: Actor, @Param('code') code: string): Promise<CreateDraftResponseDto> {
    return this.drafts.create(actor, code);
  }

  /**
   * D88's round trip: a draft that starts out holding an existing revision's
   * test data. Declared BEFORE the `:draftId` routes below only for
   * readability — `from-revision` is a longer path than any of them, so no
   * ordering hazard exists, and `DraftId`'s pipe would refuse it anyway.
   */
  @Post(':code/drafts/from-revision/:version')
  @HttpCode(201)
  @RequireScope('problems:publish')
  createFromRevision(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Param('version', new ZodValidationPipe(z.coerce.number().int().positive())) version: number,
  ): Promise<CreateDraftFromRevisionResponseDto> {
    return this.drafts.createFromRevision(actor, code, version);
  }

  /**
   * One file back out, as raw bytes.
   *
   * `@Res()` rather than a returned value, exactly as
   * `InternalPackagesController` serves an archive: the body is opaque bytes
   * of the setter's own choosing and must not be run through the JSON
   * serialiser. Same scope and same authorization as the PUT it mirrors — a
   * draft's files are a private problem's test data.
   */
  @Get(':code/drafts/:draftId/files/:name')
  @RequireScope('problems:publish')
  async getFile(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Param('draftId', new ZodValidationPipe(DraftId)) draftId: string,
    @Param('name', new ZodValidationPipe(DraftFileName)) name: string,
    @Res() res: Response,
  ): Promise<void> {
    const bytes = await this.drafts.readFile(actor, code, draftId, name);
    res.status(200).type('application/octet-stream').send(bytes);
  }

  /**
   * The body is raw file bytes, so — exactly as on `POST /packages` — it
   * never reaches a Nest body parser and is read off the stream here, bounded
   * by the same configured wire cap.
   */
  @Put(':code/drafts/:draftId/files/:name')
  @HttpCode(200)
  @RequireScope('problems:publish')
  async putFile(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Param('draftId', new ZodValidationPipe(DraftId)) draftId: string,
    @Param('name', new ZodValidationPipe(DraftFileName)) name: string,
    @Req() req: Request,
  ): Promise<DraftFileResponseDto> {
    const bytes = await readRawBody(req, this.config.packageUploadMaxBytes, 'draft_file_too_large', 'file');
    return this.drafts.putFile(actor, code, draftId, name, bytes);
  }

  @Post(':code/drafts/:draftId/build')
  @HttpCode(201)
  @RequireScope('problems:publish')
  build(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Param('draftId', new ZodValidationPipe(DraftId)) draftId: string,
    @Body(new ZodValidationPipe(BuildDraftRequest)) body: BuildDraftRequestDto,
  ): Promise<BuildDraftResponseDto> {
    return this.drafts.build(actor, code, draftId, body);
  }

  @Delete(':code/drafts/:draftId')
  @HttpCode(204)
  @RequireScope('problems:publish')
  discard(
    @CurrentActor() actor: Actor,
    @Param('code') code: string,
    @Param('draftId', new ZodValidationPipe(DraftId)) draftId: string,
  ): Promise<void> {
    return this.drafts.discard(actor, code, draftId);
  }
}

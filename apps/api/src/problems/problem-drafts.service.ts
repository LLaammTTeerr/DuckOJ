import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { buildPackage } from '@duckoj/package-format';
import {
  DRAFT_MAX_FILES,
  DRAFT_MAX_TOTAL_BYTES,
  DRAFT_TTL_MS,
  type BuildDraftRequestDto,
  type BuildDraftResponseDto,
  type CreateDraftResponseDto,
  type DraftFileResponseDto,
} from '@duckoj/contracts';
import { AppError } from '../common/app.error.js';
import type { Actor } from '../authz/actor.js';
import { ProblemAccessService } from '../authz/problem.access.js';
import { PackagesService } from '../packages/packages.service.js';
import { DRAFT_STORE, isDraftExpired, type DraftMeta, type DraftStore } from '../packages/draft.store.js';

/**
 * Browser authoring of a problem package (D87).
 *
 * The whole flow is the `package:build` CLI with the directory moved onto the
 * server: open a draft, PUT each file into it, then ask for the same
 * `buildPackage` to be run over what arrived. Nothing here re-implements
 * validation — `buildPackage` refuses an incomplete manifest, `PackagesService
 * .upload` re-derives the hash and applies D60 and the collision rule, and
 * `ProblemAccessService.attachRevision` applies them again over the stored
 * file list. This service's own job is only the three things none of those
 * can know about: who may open a draft, what a file may be called, and how
 * much a draft may hold.
 */
@Injectable()
export class ProblemDraftsService {
  constructor(
    @Inject(ProblemAccessService) private readonly problems: ProblemAccessService,
    @Inject(PackagesService) private readonly packages: PackagesService,
    @Inject(DRAFT_STORE) private readonly drafts: DraftStore,
  ) {}

  async create(actor: Actor, code: string): Promise<CreateDraftResponseDto> {
    const problem = await this.problems.loadEditableProblem(actor, code);
    const { draftId, meta } = await this.drafts.create({
      problemId: problem.id,
      problemCode: code,
      createdBy: actor.userId,
    });
    return {
      draftId,
      expiresAt: new Date(Date.parse(meta.createdAt) + DRAFT_TTL_MS).toISOString(),
      maxFiles: DRAFT_MAX_FILES,
      maxTotalBytes: DRAFT_MAX_TOTAL_BYTES,
    };
  }

  async putFile(actor: Actor, code: string, draftId: string, name: string, bytes: Buffer): Promise<DraftFileResponseDto> {
    await this.resolve(actor, code, draftId);

    const before = await this.drafts.stats(draftId);
    // Read the file's own size off disk BEFORE deciding, so re-PUTting a
    // name is measured as a replacement and not as a second copy: a setter
    // fixing one wrong answer file must not be told the draft is full
    // because the version being replaced is still counted.
    const existing = await this.sizeOf(draftId, name);
    const replacing = existing !== null;

    if (!replacing && before.fileCount >= DRAFT_MAX_FILES) {
      throw new AppError(
        422,
        'draft_too_many_files',
        `A draft holds at most ${String(DRAFT_MAX_FILES)} files; this one already has ${String(before.fileCount)}.`,
      );
    }
    const after = before.totalBytes - (existing ?? 0) + bytes.length;
    if (after > DRAFT_MAX_TOTAL_BYTES) {
      throw new AppError(
        422,
        'draft_too_large',
        `A draft holds at most ${String(DRAFT_MAX_TOTAL_BYTES)} bytes in total; this file would take it to ` +
          `${String(after)}.`,
      );
    }

    await this.drafts.putFile(draftId, name, bytes);
    return {
      name,
      sizeBytes: bytes.length,
      fileCount: replacing ? before.fileCount : before.fileCount + 1,
      totalBytes: after,
    };
  }

  /**
   * Builds what the draft holds, stores it, attaches it as a revision, and —
   * only then — deletes the draft.
   *
   * The ordering is the whole design. A build that is REFUSED leaves every
   * file in place, because the refusal a setter gets is "your manifest names
   * `03.out`, which is not here" and the only useful next act is to PUT that
   * one file and try again; deleting the draft on refusal would make every
   * mistake cost the entire upload. A build that SUCCEEDS has produced a
   * content-addressed package and a revision row that outlive the draft
   * completely, so the files are then redundant.
   *
   * Publishing happens after the delete and is deliberately not undone if it
   * fails: the revision exists, it is attached, and it is one click away from
   * being published on the revisions screen. Rolling the attach back because
   * the publish raced with another publish would discard work that succeeded.
   */
  async build(actor: Actor, code: string, draftId: string, input: BuildDraftRequestDto): Promise<BuildDraftResponseDto> {
    await this.resolve(actor, code, draftId);
    const dir = this.drafts.filesDir(draftId);

    try {
      await access(join(dir, 'manifest.json'));
    } catch {
      throw new AppError(
        422,
        'draft_build_failed',
        'The draft has no manifest.json. A package is its manifest plus the files that manifest names.',
      );
    }

    let built: Awaited<ReturnType<typeof buildPackage>>;
    try {
      built = await buildPackage(dir);
    } catch (error) {
      // `buildPackage` throws plain `Error`s — the manifest's own zod detail
      // ("tests.0.input: must be relative"), or the list of files it names
      // and the draft does not hold. Both are exactly what the author needs
      // to read, so the message rides to the wire verbatim rather than being
      // flattened into "invalid package".
      throw new AppError(422, 'draft_build_failed', error instanceof Error ? error.message : 'The draft did not build.');
    }

    // The same `POST /packages` path a CLI-built archive takes: it re-unpacks
    // and re-derives the hash rather than trusting the one just computed in
    // this process. Wasteful by a few hundred milliseconds and correct by
    // construction — there is one place a package becomes storable, and the
    // collision rule, D60's completeness rule and the idempotent insert all
    // live in it. Its `AppError`s (a path collision, an oversized inflate)
    // pass straight through with their own codes.
    await this.packages.upload(built.hash, built.archive);

    // Spread rather than `notes: input.notes` — `exactOptionalPropertyTypes`
    // makes a present-but-undefined key a different type from an absent one,
    // and `AttachRevisionInput` takes the absent form.
    const { version } = await this.problems.attachRevision(actor, code, {
      packageHash: built.hash,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    });
    await this.drafts.delete(draftId);

    let published = false;
    if (input.publish) {
      await this.problems.publishRevision(actor, code, version);
      published = true;
    }
    return { version, packageHash: built.hash, published };
  }

  async discard(actor: Actor, code: string, draftId: string): Promise<void> {
    await this.resolve(actor, code, draftId);
    await this.drafts.delete(draftId);
  }

  /**
   * The draft, once the actor is allowed to edit its problem AND the draft is
   * this problem's and still alive.
   *
   * Authorization runs FIRST, so a draft id is never a way to learn anything
   * about a problem the caller cannot see. The problem-id check after it is
   * not redundant with the URL: without it, an editor of problem A holding a
   * draft id minted against problem B could PUT files into B's draft and
   * build them into A — which is the same class of hole as an unvalidated
   * path, reached through the id instead of the name. Everything a draft
   * lookup can refuse is one 404 (`draft_not_found`): no such draft, someone
   * else's problem's draft, and an expired draft are one answer, because
   * distinguishing them tells a caller which draft ids exist.
   */
  private async resolve(actor: Actor, code: string, draftId: string): Promise<DraftMeta> {
    const problem = await this.problems.loadEditableProblem(actor, code);
    const meta = await this.drafts.read(draftId);
    if (meta === null || meta.problemId !== problem.id || isDraftExpired(meta, new Date(), DRAFT_TTL_MS)) {
      throw new AppError(404, 'draft_not_found', 'No such draft.');
    }
    return meta;
  }

  /** The stored size of one file in a draft, or `null` if it holds no such file. */
  private async sizeOf(draftId: string, name: string): Promise<number | null> {
    try {
      return (await stat(join(this.drafts.filesDir(draftId), name))).size;
    } catch {
      return null;
    }
  }
}

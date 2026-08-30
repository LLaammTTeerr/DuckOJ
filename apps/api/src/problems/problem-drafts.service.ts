import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { buildPackage, parseManifest, unpackArchive, type PackageManifestDto } from '@duckoj/package-format';
import {
  DRAFT_CHECKER_FILE_NAME,
  DRAFT_MAX_FILES,
  DRAFT_MAX_TOTAL_BYTES,
  DRAFT_TTL_MS,
  draftCaseStem,
  type BuildDraftRequestDto,
  type BuildDraftResponseDto,
  type CreateDraftFromRevisionResponseDto,
  type CreateDraftResponseDto,
  type DraftFileResponseDto,
  type DraftPrefillCaseDto,
  type DraftPrefillDto,
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

  /**
   * Opens a draft already holding an existing revision's test data (D88).
   *
   * This is the other half of D87's round trip: authoring was write-only, so
   * fixing one wrong answer file in a published problem meant retyping every
   * other test beside it. The revision's package is unpacked, the files its
   * manifest NAMES are copied into a fresh draft, and the shape of what was
   * copied comes back so a client can render it as a table.
   *
   * Two things are deliberately not preserved:
   *
   * - **Names.** A package's paths are `tests/01.in`; a draft's names are
   *   flat (D87). So every file is copied under the canonical name the
   *   authoring tab would itself have generated (`draftCaseStem`,
   *   `DRAFT_CHECKER_FILE_NAME`, shared through `@duckoj/contracts` so the
   *   two sides cannot drift), the manifest is rewritten to match, and a
   *   rebuild therefore produces a NEW hash even if nothing was edited. The
   *   alternative — keeping the original paths — would make every re-PUT
   *   from the browser land beside the old file instead of replacing it, and
   *   `buildPackage` tars whatever it finds.
   * - **Anything the manifest does not name.** Generators, validators,
   *   solutions and statements riding in a Polygon-built package are left
   *   behind. A draft is the test data a problem grades against, not an
   *   archive of how it was made, and this endpoint's caller can only ever
   *   edit the former — silently carrying the rest forward would attach a
   *   setter's `gen.py` to a package they never saw it in.
   *
   * The caps are D87's, applied BEFORE the draft is created: a revision that
   * does not fit is refused with nothing on disk rather than half-copied.
   */
  async createFromRevision(actor: Actor, code: string, version: number): Promise<CreateDraftFromRevisionResponseDto> {
    const { problemId, packageHash } = await this.problems.loadEditableRevision(actor, code, version);
    const archive = await this.packages.getArchiveBytes(packageHash);

    const workDir = await mkdtemp(join(tmpdir(), 'draft-from-rev-'));
    try {
      // The same guarded unpack `PackagesService.upload` uses — a stored
      // package was verified once, but it is still an archive being inflated
      // into this process, so D53's ceiling applies here as it does there.
      await unpackArchive(archive, workDir);
      const manifest = await this.readManifest(workDir);
      const { prefill, copies } = planPrefill(manifest);

      // `manifest.json` counts too: the draft this returns is an ORDINARY
      // draft, buildable as it stands, so it carries the rewritten manifest
      // as one of its files.
      if (copies.length + 1 > DRAFT_MAX_FILES) {
        throw new AppError(
          422,
          'draft_too_many_files',
          `A draft holds at most ${String(DRAFT_MAX_FILES)} files; revision ${String(version)} needs ` +
            `${String(copies.length + 1)}.`,
        );
      }

      const manifestBytes = Buffer.from(JSON.stringify(rewriteManifest(manifest, prefill), null, 2), 'utf8');
      let totalBytes = manifestBytes.length;
      const bytesByName = new Map<string, Buffer>();
      for (const copy of copies) {
        let bytes: Buffer;
        try {
          bytes = await readFile(join(workDir, copy.from));
        } catch {
          // D60 makes this unreachable for anything stored through
          // `POST /packages`, and it is still checked: the alternative is a
          // draft silently missing a test, which only fails much later at
          // build time naming a file the setter never chose.
          throw new AppError(
            422,
            'draft_prefill_failed',
            `Revision ${String(version)}'s package does not contain "${copy.from}", which its manifest names.`,
          );
        }
        totalBytes += bytes.length;
        if (totalBytes > DRAFT_MAX_TOTAL_BYTES) {
          throw new AppError(
            422,
            'draft_too_large',
            `A draft holds at most ${String(DRAFT_MAX_TOTAL_BYTES)} bytes in total; revision ` +
              `${String(version)} is larger.`,
          );
        }
        bytesByName.set(copy.name, bytes);
      }

      const { draftId, meta } = await this.drafts.create({ problemId, problemCode: code, createdBy: actor.userId });
      try {
        await this.drafts.putFile(draftId, 'manifest.json', manifestBytes);
        for (const [name, bytes] of bytesByName) await this.drafts.putFile(draftId, name, bytes);
      } catch (error) {
        // A half-filled draft is worse than none: it would build into a
        // package missing tests nobody asked to remove. Reclaimed here
        // rather than left to the sweeper's next tick.
        await this.drafts.delete(draftId);
        throw error;
      }

      return {
        draftId,
        expiresAt: new Date(Date.parse(meta.createdAt) + DRAFT_TTL_MS).toISOString(),
        maxFiles: DRAFT_MAX_FILES,
        maxTotalBytes: DRAFT_MAX_TOTAL_BYTES,
        fromVersion: version,
        prefill,
        fileCount: bytesByName.size + 1,
        totalBytes,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * One file back out of a draft — the read that made the round trip above
   * usable from a browser, where the table has to show the test a setter is
   * about to edit.
   *
   * Same `resolve` as every other draft route, so a draft id is never a way
   * to read a problem's tests without the right to edit that problem.
   */
  async readFile(actor: Actor, code: string, draftId: string, name: string): Promise<Buffer> {
    await this.resolve(actor, code, draftId);
    const bytes = await this.drafts.getFile(draftId, name);
    if (bytes === null) throw new AppError(404, 'draft_file_not_found', 'No such file in this draft.');
    return bytes;
  }

  /** The package's own manifest, parsed, or a 422 naming what is wrong with it. */
  private async readManifest(workDir: string): Promise<PackageManifestDto> {
    try {
      return parseManifest(JSON.parse(await readFile(join(workDir, 'manifest.json'), 'utf8')));
    } catch (error) {
      throw new AppError(
        422,
        'draft_prefill_failed',
        error instanceof Error ? error.message : "This revision's package has no readable manifest.",
      );
    }
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

/**
 * The flat draft the manifest describes: which package path becomes which
 * draft file name, and the table a client renders.
 *
 * Pure, and separate from the service, because it is the whole of D88's
 * naming rule and the only part of the round trip worth reading on its own.
 */
function planPrefill(manifest: PackageManifestDto): {
  prefill: DraftPrefillDto;
  copies: { from: string; name: string }[];
} {
  const copies: { from: string; name: string }[] = [];
  const total = manifest.tests.length;
  const cases: DraftPrefillCaseDto[] = manifest.tests.map((test, index) => {
    const stem = draftCaseStem(index, total);
    copies.push({ from: test.input, name: `${stem}.in` });
    copies.push({ from: test.answer, name: `${stem}.out` });
    return {
      input: `${stem}.in`,
      answer: `${stem}.out`,
      points: test.points,
      group: test.group,
      // Inferred, never stored: the manifest has no sample flag (D87), and a
      // case worth nothing in group 0 is exactly what the tab writes for a
      // sample. A deliberately zero-point ungrouped case comes back as a
      // sample; it grades identically either way.
      sample: test.points === 0 && test.group === 0,
    };
  });

  const checker: DraftPrefillDto['checker'] =
    manifest.checker.kind === 'source'
      ? { kind: 'source', path: DRAFT_CHECKER_FILE_NAME, language: manifest.checker.language }
      : { kind: 'standard' };
  if (manifest.checker.kind === 'source') {
    copies.push({ from: manifest.checker.path, name: DRAFT_CHECKER_FILE_NAME });
  }

  return {
    prefill: {
      name: manifest.name,
      timeMs: manifest.limits.timeMs,
      memoryKb: manifest.limits.memoryKb,
      checker,
      cases,
    },
    copies,
  };
}

/**
 * The manifest as the draft will hold it: the original's limits, name and
 * points, with every path replaced by the flat name its file was copied
 * under. Without this the draft would build a package whose manifest names
 * `tests/01.in` while the draft holds `01.in` — D60's refusal, at build
 * time, over a file the setter never touched.
 */
function rewriteManifest(manifest: PackageManifestDto, prefill: DraftPrefillDto): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    checker:
      manifest.checker.kind === 'source'
        ? { kind: 'source', path: DRAFT_CHECKER_FILE_NAME, language: manifest.checker.language }
        : { kind: 'standard' },
    limits: manifest.limits,
    tests: prefill.cases.map((c) => ({ input: c.input, answer: c.answer, points: c.points, group: c.group })),
  };
}

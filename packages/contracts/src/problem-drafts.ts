import { z } from 'zod';
import { ProblemDetails, Timestamp } from './common.js';
import { registry } from './registry.js';

/**
 * Browser authoring of a problem's test data (D87).
 *
 * A setter with no shell builds a package the same way `package:build` does,
 * only the directory being built lives on the server: create a draft, PUT
 * each file into it one at a time, then ask the server to run the very same
 * `buildPackage` over what arrived and attach the result as a revision.
 *
 * Deliberately NOT an upload of a zip. The 7a ruling (2026-08-22) refuses
 * server-side archive ingestion of caller-chosen shape — zip-slip and zip
 * bombs are surface nothing needs — and this flow does not reintroduce it:
 * every byte arrives as one named file whose name this module validates, and
 * the only archive in the story is the tar+zstd the SERVER builds at the end.
 */

/** How long an untouched draft survives before it is refused and reclaimed. */
export const DRAFT_TTL_MS = 24 * 60 * 60_000;

/**
 * The most files one draft may hold. A provincial test set is dozens of
 * files; 500 is comfortably above any real one and far below the point where
 * a directory listing or a tar of it costs anything.
 */
export const DRAFT_MAX_FILES = 500;

/**
 * The most bytes one draft may hold in total, across every file. Half the
 * 256 MiB single-request wire cap times two: a draft is a whole test set, so
 * it is allowed to be larger than any one request, and still an order of
 * magnitude below D53's 1 GiB unpacked ceiling that the built package must
 * itself clear.
 */
export const DRAFT_MAX_TOTAL_BYTES = 536_870_912;

/**
 * A draft's identity — a v4 UUID minted by the server. A path component, so
 * it is validated on the way in exactly as `PackageHash` is: an unvalidated
 * value here is a directory traversal into the package store.
 */
export const DraftId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a UUID');
export type DraftIdDto = z.infer<typeof DraftId>;

/**
 * A file's name inside a draft. Flat — no directories at all, so the package
 * a draft builds names its tests `01.in`, not `tests/01.in`.
 *
 * The character class is the whole rule and it is deliberately narrow: a
 * name reaching this endpoint becomes a path component under the package
 * store, and every interesting traversal (`..`, `/`, a NUL, a Windows drive
 * letter, a leading dash a shell would read as a flag) is simply not
 * expressible in it. The two extra refinements exist because the class ALONE
 * admits `.` and `..` — `.` and `-` are both members of it — and those two
 * names are the entire traversal vocabulary on every POSIX filesystem.
 */
export const DraftFileName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._-]+$/, 'may contain only letters, digits, dot, underscore and hyphen')
  .refine((name) => name !== '.' && name !== '..', { message: 'must not be a directory reference' });
export type DraftFileNameDto = z.infer<typeof DraftFileName>;

export const CreateDraftResponse = z.object({
  draftId: DraftId,
  expiresAt: Timestamp,
  maxFiles: z.number().int().positive(),
  maxTotalBytes: z.number().int().positive(),
});
export type CreateDraftResponseDto = z.infer<typeof CreateDraftResponse>;

export const DraftFileResponse = z.object({
  name: DraftFileName,
  sizeBytes: z.number().int().nonnegative(),
  /** The draft's totals AFTER this write, so a client can render progress. */
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
export type DraftFileResponseDto = z.infer<typeof DraftFileResponse>;

export const BuildDraftRequest = z.object({
  /**
   * Carried onto the revision row. Same shape and same 4096-character bound
   * as `AttachRevisionRequest.notes`, because it becomes exactly that field:
   * a build is an attach with the archive made on the way.
   */
  notes: z.string().max(4096).optional(),
  /**
   * Publish the revision this build attaches, in the same call. Default
   * `false`: attaching is reversible and publishing repoints what every
   * submission is graded against, so it is never a default nobody chose.
   */
  publish: z.boolean().default(false),
});
export type BuildDraftRequestDto = z.infer<typeof BuildDraftRequest>;

export const BuildDraftResponse = z.object({
  version: z.number().int().positive(),
  packageHash: z.string().regex(/^[0-9a-f]{64}$/),
  published: z.boolean(),
});
export type BuildDraftResponseDto = z.infer<typeof BuildDraftResponse>;

const DraftParams = z.object({ code: z.string(), draftId: DraftId });
const DraftFileParams = z.object({ code: z.string(), draftId: DraftId, name: DraftFileName });

const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const FORBIDDEN = {
  description: 'Signed in, but not permitted to edit this problem',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const DRAFT_NOT_FOUND = {
  description:
    'No such problem (or one the caller may not see), or no such draft — including one that has ' +
    'expired, or one belonging to a different problem',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'post',
  path: '/problems/{code}/drafts',
  tags: ['Problems'],
  summary: 'Open a package draft for browser authoring',
  description:
    'Returns an empty server-side directory to PUT individual files into. Drafts expire 24 hours ' +
    'after they are created and are reclaimed by a sweeper; an expired draft answers 404.',
  request: { params: z.object({ code: z.string() }) },
  responses: {
    201: {
      description: 'The draft was opened',
      content: { 'application/json': { schema: CreateDraftResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such problem, or one the caller may not see',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/problems/{code}/drafts/{draftId}/files/{name}',
  tags: ['Problems'],
  summary: 'Store one file in a draft',
  description:
    'The body is the raw file bytes. Names are flat and validated against ' +
    '`^[A-Za-z0-9._-]+$`; a draft holds at most 500 files and 512 MiB in total, and one request is ' +
    'bounded by the same 256 MiB wire cap as `POST /packages`. Re-PUTting a name replaces it.',
  request: {
    params: DraftFileParams,
    body: { content: { 'application/octet-stream': { schema: z.string() } } },
  },
  responses: {
    200: {
      description: 'The file was stored',
      content: { 'application/json': { schema: DraftFileResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: DRAFT_NOT_FOUND,
    413: {
      description: 'The body exceeds the single-request upload limit',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: "The name is not a valid draft file name, or the draft's file or byte cap is full",
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/problems/{code}/drafts/{draftId}/build',
  tags: ['Problems'],
  summary: "Build the draft's files into a package and attach it as a revision",
  description:
    'Runs the same `buildPackage` the `package:build` CLI runs, over the files the draft holds — so ' +
    'the draft must contain a `manifest.json` naming them. The package is stored, attached as a new ' +
    'draft revision, optionally published, and the draft is then deleted. A build that is refused ' +
    'leaves the draft in place so it can be corrected.',
  request: {
    params: DraftParams,
    body: { content: { 'application/json': { schema: BuildDraftRequest } } },
  },
  responses: {
    201: {
      description: 'The package was built and attached',
      content: { 'application/json': { schema: BuildDraftResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: DRAFT_NOT_FOUND,
    422: {
      description:
        "The draft's files do not build a package — no manifest.json, an invalid manifest, a manifest " +
        'naming files the draft does not hold, or colliding paths. The message names what is wrong.',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/problems/{code}/drafts/{draftId}',
  tags: ['Problems'],
  summary: 'Discard a draft and everything in it',
  request: { params: DraftParams },
  responses: {
    204: { description: 'The draft is gone' },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: DRAFT_NOT_FOUND,
  },
});

/* ------------------------------------------------------------------ *
 * Reading an existing revision back into a draft (D88).
 * ------------------------------------------------------------------ */

/**
 * The flat name a draft's checker source always takes.
 *
 * Canonical HERE rather than in `apps/web`, where it started, because two
 * sides now generate draft file names: the browser, planning a package out
 * of its table, and the server, flattening a stored package back into a
 * draft. If they disagreed by one character the round trip would leave the
 * old checker behind as an orphan file — packed into the rebuilt archive,
 * changing its hash — while the new one landed beside it.
 */
export const DRAFT_CHECKER_FILE_NAME = 'checker.cpp';

/**
 * The stem the `n`-th test case (0-based) of a `total`-case package takes:
 * `01`, `02`, … widening to `001` past ninety-nine so the names still sort
 * as a human reads them.
 *
 * Same reason as `DRAFT_CHECKER_FILE_NAME`: the browser and the server must
 * name the same case the same way, or a round trip renames every file it
 * touches and no re-PUT ever replaces anything.
 */
export function draftCaseStem(index: number, total: number): string {
  return String(index + 1).padStart(Math.max(2, String(total).length), '0');
}

/**
 * One case of a revision's test data, as the authoring tab needs to show it.
 *
 * `input` and `answer` are the FLAT names the files were copied into the
 * draft under, not the paths they had in the package: a Polygon package
 * names them `tests/01.in`, and a draft has no directories at all.
 */
export const DraftPrefillCase = z.object({
  input: DraftFileName,
  answer: DraftFileName,
  points: z.number(),
  group: z.number().int(),
  /**
   * Whether this case reads as a sample. Inferred, not stored: the manifest
   * has no sample FLAG (D87) and is not gaining one, so sample-ness is read
   * back off the scoring — `isSampleTest`'s "worth nothing, in a group worth
   * nothing" (D94), which recognises a Polygon package's zero-point `samples`
   * group as well as the flat `group: 0` the tab itself writes. A
   * deliberately zero-point ungrouped case that is not a sample is
   * indistinguishable from one and comes back as a sample; it grades
   * identically either way.
   */
  sample: z.boolean(),
  /**
   * The setter's prose for this sample (D94), or `''` for none — the
   * manifest's `samples[].explanation`, keyed back to this case. Empty rather
   * than absent so the tab can bind it straight to a text input, and empty on
   * every non-sample case, which cannot carry one.
   */
  explanation: z.string(),
});
export type DraftPrefillCaseDto = z.infer<typeof DraftPrefillCase>;

export const DraftPrefill = z.object({
  /** The manifest's `name`, so a rebuild does not silently rename the problem. */
  name: z.string(),
  timeMs: z.number().int().positive(),
  memoryKb: z.number().int().positive(),
  checker: z.object({
    kind: z.enum(['standard', 'source']),
    /** The flat name the checker source was copied in as, when there is one. */
    path: DraftFileName.optional(),
    language: z.string().optional(),
  }),
  cases: z.array(DraftPrefillCase),
});
export type DraftPrefillDto = z.infer<typeof DraftPrefill>;

/**
 * What `POST /problems/{code}/drafts/from-revision/{version}` answers: the
 * same envelope opening an empty draft returns, plus the shape of what was
 * copied into it.
 */
export const CreateDraftFromRevisionResponse = CreateDraftResponse.extend({
  /** The revision the draft was filled from. */
  fromVersion: z.number().int().positive(),
  prefill: DraftPrefill,
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
export type CreateDraftFromRevisionResponseDto = z.infer<typeof CreateDraftFromRevisionResponse>;

registry.registerPath({
  method: 'post',
  path: '/problems/{code}/drafts/from-revision/{version}',
  tags: ['Problems'],
  summary: "Open a draft pre-filled from an existing revision's package",
  description:
    "Copies the files the revision's manifest names — every test's input and answer, and the " +
    'checker source when it has one — into a fresh draft under flat, canonical names, and answers ' +
    'with the limits, checker and cases the manifest describes. Anything else the package carries ' +
    '(generators, validators, statements) is NOT copied: a draft is the test data this problem ' +
    'grades against, not an archive of how it was made. The draft is then an ordinary draft — PUT ' +
    "files over it and build. The same caps apply, so a revision past a draft's 500 files or 512 " +
    'MiB is refused rather than truncated.',
  request: { params: z.object({ code: z.string(), version: z.coerce.number().int().positive() }) },
  responses: {
    201: {
      description: 'The draft was opened and filled',
      content: { 'application/json': { schema: CreateDraftFromRevisionResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such problem (or one the caller may not see), or no such revision',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description:
        "The revision's package cannot be read back — an unparseable manifest, or more files or " +
        'bytes than one draft may hold',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}/drafts/{draftId}/files/{name}',
  tags: ['Problems'],
  summary: 'Read one file back out of a draft',
  description:
    'The raw bytes, exactly as they were PUT or as they were copied in from a revision. This is ' +
    'what lets the authoring tab show a published test set for editing rather than only writing a ' +
    'new one.',
  request: { params: DraftFileParams },
  responses: {
    200: {
      description: 'The file',
      content: { 'application/octet-stream': { schema: z.string() } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such problem, draft or file',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

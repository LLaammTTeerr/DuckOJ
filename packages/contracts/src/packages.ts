import { z } from 'zod';
import { ProblemDetails, Timestamp } from './common.js';
import { registry } from './registry.js';

/**
 * The package identity: a lowercase-hex SHA-256 over the canonical file list
 * (see `@duckoj/package-format`'s `packageHash`). Used both as a path
 * parameter (`GET /packages/{hash}`) and as the claimed-hash query parameter
 * on upload — one schema, so the format is enforced identically everywhere
 * it appears.
 */
export const PackageHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');
export type PackageHashDto = z.infer<typeof PackageHash>;

export const UploadPackageQuery = z.object({ hash: PackageHash });
export type UploadPackageQueryDto = z.infer<typeof UploadPackageQuery>;

export const UploadPackageResponse = z.object({ hash: PackageHash });
export type UploadPackageResponseDto = z.infer<typeof UploadPackageResponse>;

export const PackageSummary = z.object({
  hash: PackageHash,
  sizeBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export type PackageSummaryDto = z.infer<typeof PackageSummary>;

registry.registerPath({
  method: 'post',
  path: '/packages',
  summary: 'Upload a content-addressed problem package',
  description:
    'The body is the raw tar+zstd archive bytes (see @duckoj/package-format). ' +
    'The `hash` query parameter is the hash the client claims for it; the ' +
    'server unpacks the archive, recomputes the hash from the file digests, ' +
    'and rejects the upload if it disagrees.',
  request: {
    query: UploadPackageQuery,
    body: { content: { 'application/octet-stream': { schema: z.string() } } },
  },
  responses: {
    201: {
      description: 'The package was verified and stored',
      content: { 'application/json': { schema: UploadPackageResponse } },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    413: {
      description: 'The archive exceeds the server-configured upload size limit',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description:
        'The archive could not be unpacked, the claimed hash does not match its contents, the manifest ' +
        'is invalid, or two paths collide once case-folded or Unicode-normalised',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/packages/{hash}',
  summary: 'Metadata for a stored package',
  request: { params: z.object({ hash: PackageHash }) },
  responses: {
    200: { description: 'The package', content: { 'application/json': { schema: PackageSummary } } },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    404: {
      description: 'No such package',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The `hash` path parameter is not a valid package hash',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

// `GET /internal/packages/{hash}/archive` is deliberately NOT registered
// here. It is machine-to-machine (a judge fetching bytes with a judge
// credential), it is not part of the client SDK surface, and it must never
// be reachable with a user session — registering it would put it in
// `openapi.json` and the generated SDK.
//
// CI's regen-and-`git diff --exit-code` check only enforces that those two
// artifacts stay in *sync* with this file; it says nothing about which paths
// this file may register, so it would not fail if `/internal/...` were added
// here later. `test/no-internal-routes.spec.ts` is what actually makes that
// true — a structural check over every registered path, not a promise
// resting on this comment alone.

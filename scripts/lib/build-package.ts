/**
 * `buildPackage` moved into `@duckoj/package-format` (D87): the API's
 * draft-build endpoint runs the same function server-side, and `apps/api`
 * cannot import from `scripts/`. This file stays as the import path four
 * scripts already use, re-exporting the one implementation rather than
 * keeping a second copy that could drift from it.
 */
export { buildPackage, type BuiltPackage } from '@duckoj/package-format';

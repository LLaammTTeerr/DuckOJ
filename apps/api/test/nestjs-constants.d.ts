/**
 * `@nestjs/common/constants` ships no type declarations at that subpath, so a
 * typechecked test importing `PATH_METADATA` fails to resolve it.
 *
 * Declared here rather than suppressed with `@ts-expect-error`: these are the
 * real runtime exports, and naming their types is what lets the route-marker
 * coverage test stay typechecked instead of opting out of it.
 */
declare module '@nestjs/common/constants' {
  export const PATH_METADATA: string;
  export const METHOD_METADATA: string;
}

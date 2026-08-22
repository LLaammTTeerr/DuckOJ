import { z } from 'zod';
import { registry } from './registry.js';

// These three describe the document server itself (`apps/api/src/docs`), not
// business API surface — but `route-coverage.spec.ts` asserts every
// non-internal, non-probe controller route is registered here with no
// carve-out for "meta" routes, and that blanket rule is the point: a special
// case here would be exactly the kind of quiet exception that let the
// document's coverage rot to 7 of 18 routes in the first place.
registry.registerPath({
  method: 'get',
  path: '/openapi.json',
  tags: ['Meta'],
  summary: 'This document',
  description: 'Generated from the registry on every request, so it cannot drift from what the API actually serves.',
  responses: {
    200: {
      description: 'The OpenAPI 3.1 document',
      content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/docs',
  tags: ['Meta'],
  summary: 'Interactive API reference',
  responses: {
    200: {
      description: 'An HTML page that renders this document with a vendored viewer script',
      content: { 'text/html': { schema: z.string() } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/docs/scalar-standalone.js',
  tags: ['Meta'],
  summary: "The viewer's vendored script",
  description: 'Not part of the API surface — served only so `GET /docs` has no CDN dependency.',
  responses: {
    200: {
      description: 'The vendored Scalar API Reference standalone bundle',
      content: { 'text/javascript': { schema: z.string() } },
    },
  },
});

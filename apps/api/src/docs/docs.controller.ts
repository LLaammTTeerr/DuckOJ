import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { API_PREFIX } from '@duckoj/api-prefix';
import { openApiDocument } from '@duckoj/contracts';
import { Public } from '../authn/auth.guard.js';

// Resolved relative to this file rather than `process.cwd()`, so it finds
// `apps/api/assets/vendor/` the same way whether the process started as
// `tsx src/main.ts` (dev) or `node dist/main.js` (prod) — both put this
// file two directories below `apps/api`, so the walk back up is identical.
const VENDOR_SCRIPT_PATH = fileURLToPath(
  new URL('../../assets/vendor/scalar-standalone.js', import.meta.url),
);

/**
 * Read once at process start, not per-request: the vendored bundle is a few
 * MB and never changes without a redeploy.
 */
const VENDOR_SCRIPT = readFileSync(VENDOR_SCRIPT_PATH, 'utf8');

const SPEC_URL = `/${API_PREFIX}/openapi.json`;
const SCRIPT_URL = `/${API_PREFIX}/docs/scalar-standalone.js`;

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DuckOJ API reference</title>
</head>
<body>
<script id="api-reference" data-url="${SPEC_URL}" data-configuration='{"withDefaultFonts": false}'></script>
<script src="${SCRIPT_URL}"></script>
</body>
</html>
`;
}

/**
 * Serves the live OpenAPI document and an interactive viewer for it.
 *
 * The document is generated from `packages/contracts`'s registry on every
 * request rather than read from the `openapi.json` committed at the repo
 * root: that file is a build artifact (feeding SDK generation) and can drift
 * from what the running API actually registered. This endpoint cannot drift
 * from itself.
 *
 * Both routes are `@Public()`: the document and its viewer describe the API
 * surface, and gating them behind a session would mean the one place a new
 * integrator goes to learn the API is the one place they cannot reach before
 * they have credentials for it.
 *
 * Served under the API's own `/api/v1` prefix, not at the root — see
 * `app.setup.ts`'s `setGlobalPrefix` call. The `Caddyfile` proxies `/api/*`
 * and falls everything else through to the web app's `index.html`; a
 * document served at bare `/openapi.json` would answer 200 with the SPA's
 * markup instead of a 404, which is a worse failure than not serving it at
 * all. Keeping both endpoints inside `/api/v1/` means the existing `handle
 * /api/*` block already routes them and the `Caddyfile` needs no change.
 *
 * The viewer's script is vendored (`assets/vendor/scalar-standalone.js`),
 * not pulled from a CDN — the compose stack has no guaranteed outbound
 * network, and a docs page that silently fails to load offline is worse
 * than none. `withDefaultFonts: false` in `data-configuration` also keeps
 * the vendored bundle from reaching for Scalar's hosted webfonts.
 */
@Controller()
@Public()
export class DocsController {
  @Get('openapi.json')
  openapi(): unknown {
    return openApiDocument();
  }

  @Get('docs/scalar-standalone.js')
  vendorScript(@Res() res: Response): void {
    res.status(200).type('text/javascript').send(VENDOR_SCRIPT);
  }

  @Get('docs')
  viewer(@Res() res: Response): void {
    res.status(200).type('text/html').send(renderHtml());
  }
}

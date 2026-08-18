/**
 * apps/api's global route prefix (`apps/api/src/app.setup.ts`'s
 * `app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz', 'readyz'] })`).
 * Every versioned API route sits under it; `healthz`/`readyz` are the only
 * exceptions, excluded there directly.
 *
 * Exists as a single shared constant, not three independent string
 * literals, because it once WAS three copies — `app.setup.ts`,
 * `apps/judge-agent/src/materializer.ts` (which builds the judge's
 * archive-fetch URL), and `apps/web/src/api.ts` (the browser client's base
 * URL) — and one of them (`materializer.ts`) silently omitted it entirely.
 * Nothing caught that until an actual `podman-compose` bring-up did: every
 * unit test that exercised the archive route mocked `fetch` or built its
 * own unprefixed test app, so a real 404 against the real API had no test
 * to fail. A shared constant makes "add the prefix here too" the only way
 * to introduce a new call site, instead of "remember to copy the literal
 * correctly." See `apps/api/test/app.smoke.spec.ts` for the integration
 * assertion that now backs this up: it boots the real `AppModule` and
 * checks the real judge-only archive route answers at this exact prefix.
 *
 * Bare — no leading or trailing slash — matching `setGlobalPrefix`'s own
 * expected input exactly. Callers that build a URL path (`materializer.ts`,
 * `apps/web/src/api.ts`) add the slash themselves, the same way they always
 * did with the literal.
 */
export const API_PREFIX = 'api/v1';

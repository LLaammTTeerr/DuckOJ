/**
 * Every route in the published OpenAPI document, hit with deliberately bad
 * path parameters, bodies and query strings, against the **real** composition
 * root — `AppModule` behind `configureApp`, so the `/api/v1` prefix, the
 * cookie parser, the CORS layer and `ProblemFilter` are the ones production
 * runs, not a subset assembled for one spec.
 *
 * Two properties, and they are different in kind:
 *
 *  1. **No route may answer 5xx to a malformed request.** A 500 on bad input
 *     is a bug every time: either an unvalidated value reached a handler, or
 *     something threw where it should have refused. B3 already paid for one
 *     of these — a 1 MB body answered `500 internal_error` because express's
 *     json parser threw an `http-errors` object `ProblemFilter` did not
 *     recognise, and it logged at ERROR, so an oversized paste read as a
 *     server fault. That class of defect is invisible to every per-route
 *     spec, because each one tests the inputs its author thought of.
 *
 *  2. **Every status a route actually produces must be documented.** The
 *     OpenAPI document is the contract the SDK and the CLI are generated
 *     from; a status that happens but is not listed is a client that cannot
 *     handle it. This is the half that drifts silently — a route grows a 404
 *     branch in its service and nobody edits `packages/contracts`.
 *
 * The fuzzer is deliberately dumb: it does not know what any route means, it
 * substitutes junk for every `{param}` and posts junk for every body. That is
 * the point — a smart fuzzer only finds what its author already suspected.
 *
 * Sent as a plain signed-in user, not anonymously and not as an admin.
 * Anonymous would stop at `AuthGuard` and prove nothing about the handlers,
 * and an admin would start deleting things; an ordinary session reaches the
 * validation pipes and the visibility checks, which is where the interesting
 * failures live.
 */
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { TEST_CONFIG } from './app.harness.js';
import { withTestDb } from './db.harness.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Operation {
  method: string;
  path: string;
  documented: number[];
}

function operations(): Operation[] {
  const document = JSON.parse(readFileSync(join(repoRoot, 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  };
  const out: Operation[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      out.push({
        method: method.toUpperCase(),
        path,
        documented: Object.keys(operation.responses ?? {}).map(Number),
      });
    }
  }
  return out;
}

/**
 * Junk for each path parameter, chosen to be *wrong* rather than merely
 * absent: `NaN` is what the web app's `Number(params.id)` actually produced
 * on `/submissions/abc` (B4), and a one-character hash fails `PackageHash`'s
 * 64-hex shape rather than simply not existing.
 */
const BAD_PARAMS: Record<string, string> = {
  id: 'NaN',
  hash: 'zz',
  username: '!!',
  slug: '../..',
  key: '%20',
  code: '%20',
  version: 'x',
};

function fuzzPath(path: string, overrides: Record<string, string> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_match, name: string) => overrides[name] ?? BAD_PARAMS[name] ?? 'nope');
}

/**
 * Statuses any authenticated route may legitimately produce without listing
 * them, because they come from a layer above the handler rather than from the
 * route's own contract.
 *
 * Kept deliberately short. `401` is the global `AuthGuard`, `403` is
 * `ScopeGuard`/`SessionOnlyGuard`, `404` is Nest's own unrouted-path answer
 * for a URL whose parameters made it match nothing, `422` is
 * `ZodValidationPipe` on any route with a schema, and `429` is the rate
 * limiter, which is attached by decorator and is not part of any handler's
 * return type. Anything else a route produces has to be written down.
 */
const AMBIENT = new Set([400, 401, 403, 404, 422, 429]);

/**
 * The allowed browser `Origin` (D82). Every cookie-authenticated write must
 * name it or `CsrfOriginGuard` 403s before the handler — so the session pass
 * sets it on every request, which is what lets malformed bodies actually
 * reach write handlers rather than dying at the origin gate.
 */
const BROWSER_ORIGIN = TEST_CONFIG.publicOrigin;

/**
 * Each pass is one *shape* of malformed request, not one bad value. The shape
 * is what matters: a handler that survives `limit=abc` can still fall over on
 * `limit=1&limit=2`, because express parses a repeated key into an **array**,
 * and `z.coerce.number()` on an array is a different code path from
 * `z.coerce.number()` on a bad string.
 */
interface Pass {
  name: string;
  query?: Record<string, unknown>;
  /** Raw body plus its content-type, for the shapes JSON cannot express. */
  raw?: { type: string; body: string };
  body?: unknown;
  /** Per-pass path-parameter overrides merged over `BAD_PARAMS`. */
  params?: Record<string, string>;
}

const PASSES: Pass[] = [
  {
    name: 'junk json body and junk query',
    query: { limit: 'abc', cursor: '\u0000', page: '-1', unknown: '{{' },
    body: { '': null, __fuzz: [{ nested: { deeper: Number.NaN } }], id: 'not-a-number' },
  },
  {
    // Repeated keys: express yields `['1','2']` where every schema expects a
    // scalar. Historically the most productive single fuzz vector against a
    // coercing validator.
    name: 'repeated query keys',
    query: { limit: ['1', '2'], cursor: ['a', 'b'], id: ['1', '2'] },
    body: [],
  },
  {
    // Bracket notation: express's extended parser builds a nested object, so
    // a schema expecting a string is handed `{ toString: 'x' }`.
    name: 'nested query objects',
    query: { 'limit[toString]': 'x', 'cursor[__proto__][x]': '1', 'q[][]': '1' },
    body: { ['__proto__']: { polluted: true }, constructor: { prototype: {} } },
  },
  {
    name: 'a body that is not json at all',
    raw: { type: 'application/json', body: '{"unterminated": ' },
  },
  {
    name: 'a body under a content-type nothing parses',
    raw: { type: 'application/x-duckoj-nonsense', body: '\u0000\u0001binary' },
  },
  {
    // B-35 / D196. The pass before this one already sent `cursor: '\u0000'`
    // and this spec was green, which is the interesting part: the NUL never
    // reached a statement, because every route it could have reached refused
    // first for another reason. `BAD_PARAMS.slug` is `'../..'`, so
    // `findVisibleOrgRow` 404s before the roster cursor is parsed; the
    // `/users` cursor is parsed as a number and 422s; and `q` — the parameter
    // that goes straight into `nameSearchWhere` on four routes — was never
    // fuzzed at all. Measured against the live edge at `eef05c1`, seven
    // routes answered **500 `internal_error`** to an ANONYMOUS caller, path
    // parameters included. So the vector is the NUL in the PLACE it survives
    // to a bind: a path segment, `q`, and a filter that is looked up by name.
    name: 'NUL bytes in path parameters, search and filters',
    params: {
      id: '%00',
      hash: '%00',
      username: '%00',
      slug: '%00',
      key: '%00',
      code: '%00',
      version: '%00',
      setSlug: '%00',
      teamSlug: '%00',
      name: '%00',
      draftId: '%00',
      a: '%00',
      b: '%00',
    },
    query: {
      q: '\u0000',
      user: '\u0000',
      problem: '\u0000',
      contest: '\u0000',
      org: '\u0000',
      cursor: '\u0000',
    },
    body: {
      displayName: 'a\u0000b',
      name: '\u0000',
      source: 'x\u0000',
      nested: { deep: ['\u0000'] },
      // A NUL in a KEY, not a value: several columns here are `jsonb`, and
      // Postgres refuses it with `22P05` exactly as `text` refuses it with
      // `22021`.
      ['k\u0000ey']: 'x',
    },
  },
  {
    name: 'oversized and non-ascii values',
    query: { limit: 'x'.repeat(4096), cursor: '\u0000\u{1F600}', q: '%' },
    body: { name: 'x'.repeat(50_000), emoji: '\u{1F4A5}'.repeat(100) },
  },
  {
    // Numeric edges, path ids included. `99999999999999999999` parses to
    // `1e20` — larger than a `bigint`, yet `Number.isInteger` and
    // `ParseIntPipe` accept it and it is positive — so an id param validated
    // with anything short of `Number.isSafeInteger` bound it against the
    // column and answered `500 numeric_value_out_of_range`. B-30 fixed three
    // such params (`token` / `clarification` / `org-request` ids); this vector
    // is the net that keeps a fourth from shipping. `Infinity`/`NaN` and a
    // negative round out the numeric edges a coercing validator trips on.
    name: 'numeric-edge params and body',
    params: { id: '99999999999999999999', version: '1e309' },
    query: { limit: '-1', cursor: '1e309', page: 'Infinity', id: '9007199254740993' },
    body: { limit: Number.POSITIVE_INFINITY, count: -1, size: Number.MAX_SAFE_INTEGER + 2, ratio: Number.NaN },
  },
];

describe('every documented route, fuzzed', () => {
  it('answers no 5xx, and no undocumented status', async () => {
    await withTestDb(async (db) => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DB)
        .useValue(db)
        .overrideProvider(APP_CONFIG)
        .useValue(TEST_CONFIG)
        .compile();

      const app = moduleRef.createNestApplication();
      configureApp(app, TEST_CONFIG);
      await app.init();

      try {
        const agent = request.agent(app.getHttpServer());
        const username = 'fuzzer';
        await agent
          .post('/api/v1/auth/register')
          .set('X-Forwarded-For', '198.51.100.7')
          .send({
            username,
            email: `${username}@example.com`,
            password: 'a-long-enough-password',
            displayName: username,
          });
        const login = await agent
          .post('/api/v1/auth/login')
          .send({ usernameOrEmail: username, password: 'a-long-enough-password' });
        expect(login.status, 'the fuzzer could not sign in').toBe(200);

        // A scopeless token, minted by the same session. `POST /auth/tokens`
        // is a cookie write, so it needs the `Origin` D82 demands — the same
        // header the session pass below sets on every request.
        const minted = await agent
          .post('/api/v1/auth/tokens')
          .set('Origin', BROWSER_ORIGIN)
          .send({ name: 'fuzz', scopes: [] });
        expect(minted.status, 'the fuzzer could not mint a token').toBe(201);
        const token = (minted.body as { token: string }).token;

        const serverErrors: string[] = [];
        const undocumented: string[] = [];
        const notProblemJson: string[] = [];
        /**
         * Every status observed, so this test cannot pass vacuously. A
         * fuzzer whose session silently expired would 401 on everything and
         * satisfy all three assertions above while proving nothing about any
         * handler — this is the guard against that.
         */
        const seen = new Map<number, number>();
        /**
         * Session-pass writes (POST/PATCH/PUT/DELETE) that reached validation
         * (a 422). Before B-30 this spec sent no `Origin`, so every cookie
         * write stopped at D82's origin gate with a 403 and no malformed body
         * ever reached a write handler — the fuzz silently covered reads only.
         * Asserting at least one write 422s is the guard that keeps that
         * regression from returning: a 422 can only come from the validation
         * pipe, which sits *past* the guards.
         */
        let writeReachedValidation = 0;
        const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

        /**
         * Two credential shapes, because they travel different middleware. A
         * cookie session (with the `Origin` D82 requires) reaches write
         * handlers; a bearer token skips the origin gate but must be stopped
         * by `ScopeGuard` on any `@RequireScope` write it lacks the scope for
         * — so the token pass is also the standing proof that a scopeless
         * token cannot write, on every route at once.
         */
        const modes = [
          { label: 'session', bearer: undefined as string | undefined },
          { label: 'token', bearer: token },
        ];

        for (const mode of modes) {
          for (const pass of PASSES) {
            for (const operation of operations()) {
              // Logout would end the very session the rest of the pass rides
              // on; skipping it costs no coverage (it takes no input).
              if (operation.path === '/auth/logout') continue;
              const url = `/api/v1${fuzzPath(operation.path, pass.params)}`;
              let call = agent[operation.method.toLowerCase() as 'get'](url);
              call = mode.bearer
                ? call.set('Authorization', `Bearer ${mode.bearer}`)
                : call.set('Origin', BROWSER_ORIGIN);
              if (pass.query) call = call.query(pass.query);
              if (pass.raw) {
                call = call.set('Content-Type', pass.raw.type).send(pass.raw.body as never);
              } else if (pass.body !== undefined && operation.method !== 'GET' && operation.method !== 'DELETE') {
                call = call.send(pass.body as never);
              }
              const res = await call;
              seen.set(res.status, (seen.get(res.status) ?? 0) + 1);
              if (mode.label === 'session' && WRITE_METHODS.has(operation.method) && res.status === 422) {
                writeReachedValidation++;
              }
              const where = `[${mode.label}/${pass.name}] ${operation.method} ${operation.path} -> ${String(res.status)}`;

              if (res.status >= 500) {
                serverErrors.push(`${where} ${JSON.stringify(res.body).slice(0, 200)}`);
                continue;
              }
              if (!operation.documented.includes(res.status) && !AMBIENT.has(res.status)) {
                undocumented.push(`${where} (documented: ${operation.documented.join(',')})`);
              }

              // Every refusal is RFC 9457, whoever produced it. This is the
              // generalisation of B3's finding: an error raised ABOVE the
              // handler (the body parser's 400/413, a guard's 401) travels a
              // different path from an `AppError` a service threw, and only
              // `ProblemFilter` makes the two look alike on the wire. A client
              // parsing `code` must never be handed express's default HTML
              // error page instead.
              if (res.status >= 400) {
                const type = String(res.headers['content-type'] ?? '');
                if (!type.includes('application/problem+json')) {
                  notProblemJson.push(`${where} content-type: ${type || '(none)'}`);
                } else if (typeof res.body?.status !== 'number' || typeof res.body?.code !== 'string') {
                  notProblemJson.push(`${where} body: ${JSON.stringify(res.body).slice(0, 120)}`);
                }
              }
            }
          }
        }

        expect(serverErrors, 'routes answered 5xx to malformed input').toEqual([]);
        expect(undocumented, 'routes produced a status their contract does not list').toEqual([]);
        expect(notProblemJson, 'errors that are not application/problem+json').toEqual([]);

        const total = [...seen.values()].reduce((a, b) => a + b, 0);
        expect(total, 'the fuzzer sent nothing').toBeGreaterThan(300);
        // Handlers actually ran: a 2xx means the request went all the way
        // through routing, guards, pipes and a service.
        expect([...seen.keys()].some((status) => status < 300), `statuses seen: ${[...seen.keys()].join(',')}`).toBe(
          true,
        );
        // And the session held: an expired one would make every line a 401.
        expect(seen.get(401) ?? 0).toBeLessThan(total / 2);
        // Write bodies reached a validation pipe, not just a guard — see the
        // comment on `writeReachedValidation`. Without the `Origin` header the
        // session pass sets, this is 0.
        expect(writeReachedValidation, 'no write route reached its validation pipe').toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });
  }, 300_000);
});

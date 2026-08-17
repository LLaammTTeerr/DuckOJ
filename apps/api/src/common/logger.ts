import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { DestinationStream } from 'pino';

/**
 * Header paths scrubbed from every request/response log line.
 *
 * `pino-http` serializes `req` and `res` with `pino-std-serializers`, which
 * assigns `req.headers` and `res.getHeaders()` wholesale. Without this, the raw
 * session cookie, the raw bearer token, and the `Set-Cookie` that issues a fresh
 * session on login are all written to stdout on *every* request, at `info` —
 * which is the level `docker-compose.yml` runs production at.
 *
 * That would invert the branch's own design. `SessionService` and `TokenService`
 * deliberately persist only `hashToken(token)`, so that a database leak yields
 * nothing replayable; printing the plaintext of the same credential to the
 * container log undoes that entirely, and log aggregation usually has a wider
 * blast radius than the database does.
 *
 * Node lowercases incoming request header names, and `res.getHeaders()` returns
 * lowercase keys, so these paths are written lowercase. `set-cookie` uses
 * bracket syntax, pino's documented form for a key that is not a bare
 * identifier. A redact path that matches nothing fails *silently* and produces
 * output indistinguishable from a working config, so none of this was assumed:
 * the paths were checked against real emitted output for this pino version, and
 * `test/logging.spec.ts` keeps them honest as the app grows.
 */
const REDACTED_HEADERS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];

export function requestLogger(level: string, destination?: DestinationStream) {
  return pinoHttp(
    {
      level,
      redact: { paths: REDACTED_HEADERS, censor: '[redacted]' },
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    },
    destination,
  );
}

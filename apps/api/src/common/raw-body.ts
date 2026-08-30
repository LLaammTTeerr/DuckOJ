import type { Request } from 'express';
import { AppError } from './app.error.js';

/**
 * Reads a request body that is raw bytes rather than JSON, bounded.
 *
 * Neither of Nest's default parsers (`json`, `urlencoded`) touches the
 * request stream for a non-matching `Content-Type`, so the stream reaches the
 * handler untouched and is read here directly. Bounded, so a caller cannot
 * force unbounded buffering by simply not stopping.
 *
 * On an over-limit body this stops *accumulating* (`req.pause()`) but
 * deliberately does not `req.destroy()` the socket immediately: `req` and
 * `res` share one connection, and destroying it before the rejection has
 * propagated through Nest's exception handling means `ProblemFilter` never
 * gets a chance to write a response on it — the caller sees a bare
 * `socket hang up`, not the `413` the route is supposed to answer with. The
 * socket is destroyed only once the response has actually finished writing,
 * to drop whatever excess bytes are still arriving.
 *
 * Shared rather than copied: `POST /packages` and D87's
 * `PUT /problems/{code}/drafts/{draftId}/files/{name}` both need it, and the
 * pause-then-destroy-on-finish dance above is exactly the kind of detail a
 * second copy loses.
 */
export function readRawBody(req: Request, limit: number, code: string, what: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        req.pause();
        req.res?.once('finish', () => req.destroy());
        reject(new AppError(413, code, `The ${what} exceeds the ${limit}-byte upload limit.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

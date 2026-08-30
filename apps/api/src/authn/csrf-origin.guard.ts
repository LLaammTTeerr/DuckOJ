/**
 * The second CSRF layer: an Origin/Referer check on every cookie-authenticated
 * state change (D82).
 *
 * B10 cleared CSRF and recorded the clearance as **single-layer**:
 * `SameSite=Lax` withholds the session cookie from every cross-site unsafe
 * method, and every state change here is an unsafe method, so Lax's
 * top-level-GET allowance grants an attacker nothing. That argument is
 * correct and it rests entirely on one browser feature behaving as
 * documented — no token, no second check, nothing that fails independently.
 * D70 had already made exactly this argument for the WebSocket upgrade and
 * added an Origin check anyway; this is the same check for the other half of
 * the surface.
 *
 * The rule, in one sentence: **a state-changing request that carries a
 * session cookie must say where it came from, and where it came from must be
 * ours.**
 */
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';

/**
 * Methods a browser will send cross-site without the cookie under `SameSite=
 * Lax`, and which by convention change nothing.
 *
 * A NEGATIVE list rather than the positive `POST`/`PATCH`/`DELETE` the brief
 * names: those three are what exists today, and a `PUT` route added next
 * month would be silently exempt from a positive list without anyone
 * noticing. Exempting what is safe and checking the rest fails in the
 * direction that gets caught. `OPTIONS` is here so a CORS preflight — which
 * carries no cookie and asks permission for the real request that follows —
 * is never itself refused.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// RFC 6750: the "Bearer" auth-scheme token is case-insensitive. Same regexp
// shape as `AuthGuard`'s, which is the check this one has to agree with.
const BEARER_SCHEME = /^Bearer\s+/i;

@Injectable()
export class CsrfOriginGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

    // A **bearer** request is not CSRF-able and is not checked, even when a
    // cookie rides along on it: `AuthGuard.attachActor` authenticates by the
    // token and never reads the cookie, and a hostile page cannot set an
    // `Authorization` header at all without a preflight this API answers only
    // for its own origin. Checking it anyway would break every machine client
    // — `oj`, the judge agent, CI — none of which has an origin to send.
    const authorization = req.get('authorization');
    if (authorization && BEARER_SCHEME.test(authorization)) return true;

    // Cookie PRESENCE, not validity. The question is not "is this caller
    // signed in" — it is "could the browser have attached ambient
    // credentials to this request", and a cookie the server will reject was
    // still attached by the browser. Deciding on validity would also mean
    // running this after `AuthGuard`, and a stale cookie would then take the
    // CSRF-shaped request all the way to a handler.
    const cookie = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[
      this.config.sessionCookieName
    ];
    if (cookie === undefined) return true;

    const origin = this.requestOrigin(req);
    // NEITHER header, with a session cookie, is a refusal — not a pass. This
    // is the whole difference from D70's WebSocket ruling, which deliberately
    // ALLOWS a missing `Origin` because the clients that send none (`oj`, the
    // judge agent) "carry no ambient cookie". Here the cookie is the premise:
    // a request that has one and will not say where it came from is either a
    // browser that has been made not to say, or a client that should have
    // used a token. Both are refused.
    if (origin === null || !this.config.wsAllowedOrigins.includes(origin)) {
      throw new AppError(
        403,
        'csrf_origin',
        'This request did not come from an allowed origin.',
      );
    }
    return true;
  }

  /**
   * Where the browser says this request came from, or `null`.
   *
   * `Origin` first, because it is the header that exists for this and is sent
   * on every unsafe method by every browser this decade. `Referer` is the
   * fallback for the one case `Origin` can be absent from a real navigation
   * — a form post under a `Referrer-Policy` that keeps the referrer but some
   * intermediary stripped `Origin` — and it is reduced to its ORIGIN before
   * it is compared, because a `Referer` carries a path and a path is not a
   * trust boundary.
   *
   * `Origin: null` — which a sandboxed iframe or a `data:` document sends —
   * is returned as the literal string and then fails list membership, which
   * is the correct answer: an opaque origin is not ours.
   */
  private requestOrigin(req: Request): string | null {
    const origin = req.get('origin');
    if (origin !== undefined && origin !== '') return origin;
    const referer = req.get('referer');
    if (referer === undefined || referer === '') return null;
    try {
      return new URL(referer).origin;
    } catch {
      // A malformed `Referer` says nothing, so it is treated as absent —
      // which, with a cookie present, is a refusal.
      return null;
    }
  }
}

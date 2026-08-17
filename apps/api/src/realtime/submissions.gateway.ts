import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';
import { SessionService } from '../authn/session.service.js';
import { TokenService } from '../authn/token.service.js';
import { SubmissionAccessService } from '../authz/submission.access.js';
import type { Actor } from '../authz/actor.js';

const BEARER_SCHEME = /^Bearer\s+/i;

interface Client {
  actor: Actor;
  subscriptions: Set<number>;
}

/**
 * The API's deny-by-default `APP_GUARD` covers HTTP routes only — a WebSocket
 * upgrade never passes through it. Everything this class does about
 * authentication and authorization is therefore load-bearing rather than
 * defence in depth: get it wrong and there is nothing behind it.
 */
@Injectable()
export class SubmissionsGateway {
  // `ws` defaults to a 100 MB max frame. The only message this endpoint ever
  // accepts is a two-field `subscribe` object, so anything approaching that
  // default is abuse, not a legitimate client.
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Map<WebSocket, Client>();

  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SubmissionAccessService) private readonly submissions: SubmissionAccessService,
    @Inject('SESSION_COOKIE_NAME') private readonly cookieName: string,
  ) {}

  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => {
      // The upgrade path is partly synchronous (the URL parse below) and
      // partly async (`authenticate` touches the database). An abrupt client
      // disconnect at any point in that window fires 'error' on this raw
      // socket; with no listener that is an uncaught exception on the
      // process — the same crash class as the unhandled rejection guarded
      // against below. Attach before anything else can throw or reject.
      socket.on('error', () => socket.destroy());

      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }

      if (pathname !== '/ws') {
        // Node's contract: once a listener is registered for 'upgrade',
        // disposing of a connection it doesn't accept becomes that
        // listener's job — Node no longer does it automatically. A bare
        // `return` here would leave the socket open with nothing owning it,
        // letting an unauthenticated caller hold sockets open indefinitely
        // by upgrading to any path other than `/ws`.
        socket.destroy();
        return;
      }

      void this.authenticate(req)
        .then((actor) => {
          if (!actor) {
            // Rejected before the socket opens, so an unauthenticated caller
            // never holds an open connection at all.
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, actor));
        })
        .catch(() => {
          // `authenticate` touches the database via `sessions.resolve` /
          // `tokens.resolve`, so it is never actually total. Without this
          // `.catch`, any throw inside it — a transient database error, or
          // (before the parser below was made total) a malformed cookie —
          // becomes an unhandled promise rejection, and Node 22 terminates
          // the process on those by default. A single bad connection must
          // never take the whole API down with it.
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
    });
  }

  private async authenticate(req: IncomingMessage): Promise<Actor | null> {
    const header = req.headers.authorization;
    if (header && BEARER_SCHEME.test(header)) {
      return this.tokens.resolve(header.replace(BEARER_SCHEME, ''));
    }

    // Credentials are NEVER read from the query string. `?token=` would work
    // in every client and would write the credential into access logs, proxy
    // logs and browser history — the exact leak closed in phase 0. Browsers
    // cannot set headers on a WebSocket, so they use the cookie; programmatic
    // clients set the header.
    const cookie = parseCookie(req.headers.cookie ?? '')[this.cookieName];
    return cookie ? this.sessions.resolve(cookie) : null;
  }

  private accept(ws: WebSocket, actor: Actor): void {
    this.clients.set(ws, { actor, subscriptions: new Set() });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => {
      // An unhandled 'error' on a `WebSocket` is an uncaught exception on
      // the process — reachable by any abrupt client disconnect after the
      // upgrade has already completed, so it is reachable by any signed-in
      // caller, not just an attacker probing the handshake.
      this.clients.delete(ws);
      ws.terminate();
    });
    ws.on('message', (raw) => void this.onMessage(ws, String(raw)));
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    const client = this.clients.get(ws);
    if (!client) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const submissionId = readSubscribeMessage(parsed);
    if (submissionId === null) return;

    try {
      // Authorizing the SUBSCRIPTION, not merely the connection. Without this
      // any signed-in user could watch anyone's grading in real time.
      await this.submissions.getVisible(client.actor, submissionId);
      client.subscriptions.add(submissionId);
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'submission_not_found' }));
    }
  }

  /** Called by the Redis subscriber. The payload is a signal, never data. */
  notify(submissionId: number): void {
    const message = JSON.stringify({ type: 'submission', id: submissionId });
    for (const [ws, client] of this.clients) {
      // A socket in `CLOSING` has not yet fired 'close', so it is still in
      // `this.clients`; sending to it surfaces as an 'error' event rather
      // than failing silently, which `accept`'s handler would then tear down
      // — harmless, but pointless. Only send to sockets actually open.
      if (client.subscriptions.has(submissionId) && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}

/**
 * `JSON.parse` can hand back anything JSON allows — a string, a number, an
 * array, or `null` — not just the two-field object the brief's original
 * `{ type?: string; submissionId?: number }` cast assumed. `null.type` throws,
 * and that throw is inside an `async` method invoked as `void this.onMessage(...)`,
 * so it becomes an unhandled rejection: the same crash class as an
 * unauthenticated client sending a malformed cookie, except reachable by any
 * already-authenticated one sending a single WebSocket frame.
 */
function readSubscribeMessage(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const { type, submissionId } = value as { type?: unknown; submissionId?: unknown };
  return type === 'subscribe' && typeof submissionId === 'number' ? submissionId : null;
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    let value = part.slice(index + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // A malformed percent-escape (`%zz`) must not crash the caller — keep
      // the raw value. It simply won't match any real session token, so
      // `authenticate` falls through to an ordinary 401.
    }
    out[part.slice(0, index).trim()] = value;
  }
  return out;
}

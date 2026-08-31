import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';
import { describeError } from '@duckoj/observability';
import { SessionService } from '../authn/session.service.js';
import { TokenService } from '../authn/token.service.js';
import { SubmissionAccessService } from '../authz/submission.access.js';
import { ContestMonitorService } from '../authz/contest.monitor.js';
import { CONTEST_PRESENCE, type ContestPresence } from './contest-presence.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from '../authz/actor.js';

const BEARER_SCHEME = /^Bearer\s+/i;

// A client that misses two consecutive pings (one full interval with no
// pong reply) is presumed dead and torn down. Half-open connections — a
// laptop lid closing, a NAT timeout, a mobile handoff — send neither `close`
// nor `error`, and `ws` sends no keepalive of its own by default: without
// this sweep, a half-open client's entry (and its subscriptions) would
// survive until OS-level TCP keepalive, commonly hours if enabled at all,
// with `notify` writing frames into a socket nobody is reading.
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The reason phrase for a refusal status line, for the handful of statuses a
 * deliberate refusal during the upgrade can carry.
 *
 * A status LINE needs a phrase; HTTP/1.1 allows any text, but a client
 * reading the raw line is a person debugging, so the registered phrase is
 * the useful one. Anything unlisted falls back to the status alone rather
 * than to a guess.
 */
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
};

function statusText(status: number): string {
  return STATUS_TEXT[status] ?? '';
}

/**
 * How many submissions one connection may watch at once.
 *
 * `subscriptions` was append-only and unbounded, and nothing but closing the
 * socket ever removed an id from it. Two consequences, both reachable by any
 * ordinary signed-in caller:
 *
 *  - **Cost.** Every `subscribe` frame runs `getVisible`, which is three
 *    queries and loads the submission's SOURCE and its whole case grid — a
 *    full detail read, done only to answer a yes/no authorization question.
 *    A client with a few thousand of its own submissions (a season of
 *    practice) can spend them all in one burst down a single socket, with no
 *    rate limit anywhere on this path.
 *  - **Memory.** The Set grows for the life of the connection, and a
 *    half-open connection lives until the heartbeat sweep notices.
 *
 *  256 is far more than any real page watches — the web opens ONE socket per
 *  submission — and small enough that a thousand connections at the cap is
 *  bookkeeping rather than a leak. A client that legitimately needs more
 *  releases what it no longer needs with `unsubscribe`, which is what makes
 *  a cap fair rather than merely a wall.
 *
 * Injected through `MAX_SUBSCRIPTIONS` rather than read as a module
 * constant, for the same reason `MAX_UNPACKED_BYTES` is a parameter (D53): a
 * test can then prove the bound at 2 instead of standing up 257 submissions.
 */
export const MAX_SUBSCRIPTIONS = Symbol('MAX_SUBSCRIPTIONS');
export const DEFAULT_MAX_SUBSCRIPTIONS = 256;

/**
 * How many contests one connection may watch at once (D95).
 *
 * `subscribe`'s cap exists for two reasons and this one shares both: a
 * `watch-contest` frame costs two queries (`loadVisible` plus its visibility
 * context) before it can be refused, and the Set it feeds lives for the life
 * of the connection. Eight rather than 256 because there is no plausible
 * client that watches more — the monitor page watches exactly one, and an
 * organiser with every contest of a province open on one socket is a script,
 * not a person.
 *
 * Injected for `MAX_SUBSCRIPTIONS`' reason: a test can then meet the cap with
 * two contests instead of nine.
 */
export const MAX_CONTEST_WATCHES = Symbol('MAX_CONTEST_WATCHES');
export const DEFAULT_MAX_CONTEST_WATCHES = 8;

/**
 * The single browser origin permitted to open this socket (the deployment's
 * `publicOrigin`, the same value CORS pins). Injected so the check below has
 * something to compare against without reaching into config itself.
 */
export const ALLOWED_WS_ORIGIN = Symbol('ALLOWED_WS_ORIGIN');

interface Client {
  actor: Actor;
  subscriptions: Set<number>;
  /**
   * Ids whose authorization is in flight right now — a reservation against
   * the cap, held from before `getVisible` is awaited until it answers.
   *
   * Without it the cap is a check on a value that cannot have changed yet:
   * `subscriptions.size` is read synchronously and the `add` happens after
   * three queries, while `ws` emits every frame that arrived in one read
   * synchronously and each handler is launched as `void this.onMessage(...)`.
   * So a burst of N frames all read an empty set, all pass, and all reach the
   * database — the exact flood the cap exists to make free, plus a
   * `subscriptions` set that ends up above its own bound. Counted with
   * `subscriptions` and released in a `finally`, so a refusal costs no slot.
   */
  pending: Set<number>;
  /**
   * Contests this socket receives `contest-activity` for, by canonical key
   * (D95). Organiser-only: every entry got here through
   * `ContestMonitorService.assertMayWatch`.
   */
  contests: Set<string>;
  /**
   * `pending`'s twin for `watch-contest`, keyed by the LOWERCASED key the
   * client sent — the canonical spelling is only known once `assertMayWatch`
   * answers, and contest keys are case-folded (D8), so lowercasing is what
   * makes two spellings of one in-flight watch a single reservation.
   */
  pendingContests: Set<string>;
  /** Set on each ping, cleared on the matching pong. Still set at the next
   * sweep means the previous ping went unanswered. */
  awaitingPong: boolean;
}

/**
 * The API's deny-by-default `APP_GUARD` covers HTTP routes only — a WebSocket
 * upgrade never passes through it. Everything this class does about
 * authentication and authorization is therefore load-bearing rather than
 * defence in depth: get it wrong and there is nothing behind it.
 */
@Injectable()
export class SubmissionsGateway implements OnModuleDestroy {
  // `ws` defaults to a 100 MB max frame. The only message this endpoint ever
  // accepts is a two-field `subscribe` object, so anything approaching that
  // default is abuse, not a legitimate client.
  private readonly logger = new Logger(SubmissionsGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Map<WebSocket, Client>();
  private httpServer: HttpServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // A bound instance method (not an inline arrow in `attach`) so
  // `onModuleDestroy` can `removeListener` this exact function reference —
  // an inline closure could only ever be removed by removing *all*
  // 'upgrade' listeners, which isn't this class's call on a shared server.
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
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
      // disposing of a connection it doesn't accept becomes that listener's
      // job — Node no longer does it automatically. A bare `return` here
      // would leave the socket open with nothing owning it, letting an
      // unauthenticated caller hold sockets open indefinitely by upgrading
      // to any path other than `/ws`.
      socket.destroy();
      return;
    }

    // Cross-Site WebSocket Hijacking defence. A `new WebSocket()` from an
    // attacker's page is not subject to CORS and this gateway authenticates a
    // browser by its session COOKIE — so the only thing standing between a
    // malicious origin and the victim's live submission feed is that the
    // cookie is `SameSite=Lax` (which withholds it from a cross-site handshake).
    // That is one control; this is the second, and the standard one. A real
    // browser always stamps `Origin` on the upgrade, so a present-but-wrong
    // Origin is a cross-site attempt and is refused. A MISSING Origin is a
    // non-browser client (the `oj` CLI, a test) that carries no ambient cookie
    // to abuse and authenticates by bearer token — allowed, exactly as CORS
    // lets a header-less request through.
    const origin = req.headers.origin;
    if (origin !== undefined && !this.allowedOrigins.includes(origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    void this.authenticate(req)
      .then((actor) => {
        if (!actor) {
          // Rejected before the socket opens, so an unauthenticated caller
          // never holds an open connection at all. `end`, not `write` +
          // `destroy`: `destroy()` may discard a write still sitting in the
          // socket's buffer, so the client can't reliably observe the
          // status line it was sent.
          socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, actor));
      })
      .catch((error: unknown) => {
        // `authenticate` touches the database via `sessions.resolve` /
        // `tokens.resolve`, so it is never actually total. Without this
        // `.catch`, any throw inside it — a transient database error, or
        // (before the parser below was made total) a malformed cookie —
        // becomes an unhandled promise rejection, and Node 22 terminates
        // the process on those by default. A single bad connection must
        // never take the whole API down with it.
        //
        // A deliberate refusal is carried through with its own status (D102:
        // `tokens.resolve` refuses a flagged account's token). Reporting a
        // ruling as `500 Internal Server Error` tells a client to retry the
        // one thing that can never work, which is the exact diagnostic shape
        // B-17 removed from the MCP surface.
        if (error instanceof AppError) {
          socket.end(`HTTP/1.1 ${String(error.status)} ${statusText(error.status)}\r\n\r\n`);
          return;
        }
        socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      });
  };

  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SubmissionAccessService) private readonly submissions: SubmissionAccessService,
    @Inject('SESSION_COOKIE_NAME') private readonly cookieName: string,
    @Inject(MAX_SUBSCRIPTIONS) private readonly maxSubscriptions: number,
    @Inject(ALLOWED_WS_ORIGIN) private readonly allowedOrigins: readonly string[],
    @Inject(MAX_CONTEST_WATCHES) private readonly maxContestWatches: number,
    @Inject(ContestMonitorService) private readonly monitor: ContestMonitorService,
    @Inject(CONTEST_PRESENCE) private readonly presence: ContestPresence,
  ) {}

  attach(server: HttpServer): void {
    this.httpServer = server;
    server.on('upgrade', this.onUpgrade);
    this.heartbeatTimer = setInterval(() => this.sweep(), HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Nothing calls `app.close()` in production today — `main.ts` never does —
   * but graceful shutdown is plausible in a later task, and at that point an
   * open WebSocket (or a live heartbeat interval, which itself holds the
   * process open) would otherwise stop the process from ever exiting. Tests
   * hit this every run: `app.close()` is `SubmissionsGateway`'s
   * `onModuleDestroy`, so a leak here is a leak in every `finally` block in
   * the suite, not just a theoretical production gap.
   */
  onModuleDestroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.httpServer) this.httpServer.removeListener('upgrade', this.onUpgrade);
    this.httpServer = null;
    for (const ws of this.clients.keys()) ws.terminate();
    this.clients.clear();
    this.wss.close();
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
    this.clients.set(ws, {
      actor,
      subscriptions: new Set(),
      pending: new Set(),
      contests: new Set(),
      pendingContests: new Set(),
      awaitingPong: false,
    });
    // Presence, at once rather than at the next sweep (D95): a competitor who
    // has just opened their page must count towards the monitor's "in the
    // room" number now, not up to thirty seconds from now. Best-effort by
    // construction — `ContestPresence` swallows everything — so a Redis
    // outage costs a decorative number and never a handshake.
    void this.presence.seen([actor.userId]);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => {
      // An unhandled 'error' on a `WebSocket` is an uncaught exception on
      // the process — reachable by any abrupt client disconnect after the
      // upgrade has already completed, so it is reachable by any signed-in
      // caller, not just an attacker probing the handshake.
      this.clients.delete(ws);
      ws.terminate();
    });
    ws.on('pong', () => {
      const client = this.clients.get(ws);
      if (client) client.awaitingPong = false;
    });
    ws.on('message', (raw) => void this.onMessage(ws, String(raw)));
  }

  /** Pings every client; terminates whichever one didn't answer the previous round. */
  private sweep(): void {
    const alive: number[] = [];
    for (const [ws, client] of this.clients) {
      if (client.awaitingPong) {
        this.clients.delete(ws);
        ws.terminate();
        continue;
      }
      client.awaitingPong = true;
      ws.ping();
      alive.push(client.actor.userId);
    }
    // One write per sweep for every surviving connection, not one per
    // connection: `PRESENCE_WINDOW_MS` is ten sweeps wide, so a socket that
    // stays open is re-scored long before it ages out, and a socket the sweep
    // has just torn down is deliberately NOT re-scored — it ages out on its
    // own, which is what makes a closed laptop stop counting. Collected
    // first, then written, so a slow Redis cannot delay the ping loop.
    void this.presence.seen(alive);
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

    const message = readClientMessage(parsed);
    if (message === null) return;

    if (message.type === 'watch-contest') {
      await this.watchContest(ws, client, message.key);
      return;
    }

    if (message.type === 'unwatch-contest') {
      // `unsubscribe`'s rule, for `unsubscribe`'s reason: never authorized
      // and never an error, so releasing a watch you do not hold cannot be
      // used to tell an existing contest from one that never existed.
      //
      // Matched case-insensitively, because `watchContest` deliberately is:
      // it accepts any spelling and stores the CANONICAL key, so a raw
      // `delete` of what the client sent releases nothing whenever the two
      // differ — and the client's own `watch-contest` frame is exactly the
      // spelling it would send back. The socket then kept the activity
      // frames and kept a slot against `maxContestWatches`, from a frame the
      // server had just acknowledged.
      for (const held of client.contests) {
        if (held.toLowerCase() === message.key.toLowerCase()) client.contests.delete(held);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'contest-unwatched', key: message.key }));
      }
      return;
    }

    if (message.type === 'unsubscribe') {
      // Never authorized and never an error: releasing a subscription you do
      // not hold is a no-op, and answering anything else would make this
      // frame an existence oracle for ids the caller cannot see.
      client.subscriptions.delete(message.submissionId);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribed', id: message.submissionId }));
      }
      return;
    }

    const submissionId = message.submissionId;

    // Re-acked without touching the database. A client that re-subscribes on
    // every reconnect (the web does) must not pay a full detail read for a
    // subscription it already holds, and this is also what keeps a flood of
    // repeats from being an amplifier.
    if (client.subscriptions.has(submissionId)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'subscribed', id: submissionId }));
      }
      return;
    }

    // A second frame for an id already being authorized is that same
    // subscription, not a new one: the in-flight call will ack it. Dropped
    // rather than counted, so a client that repeats itself cannot spend its
    // own cap on one id.
    if (client.pending.has(submissionId)) return;

    // Checked BEFORE `getVisible`, deliberately: past the cap a flood must
    // cost this process nothing at all, and a refusal that first ran three
    // queries would be the cheapest half of the attack it exists to stop.
    // `pending` counts here for exactly that reason — see its declaration:
    // without it the check is on a set the burst has not had time to grow.
    if (client.subscriptions.size + client.pending.size >= this.maxSubscriptions) {
      ws.send(JSON.stringify({ type: 'error', code: 'subscription_limit' }));
      return;
    }

    client.pending.add(submissionId);
    try {
      // Authorizing the SUBSCRIPTION, not merely the connection. Without this
      // any signed-in user could watch anyone's grading in real time.
      await this.submissions.getVisible(client.actor, submissionId);
      client.subscriptions.add(submissionId);
      // The ack closes a real staleness window: the client's post-subscribe
      // re-fetch used to race the multi-query authz above — a terminal
      // publish landing between the re-fetch's snapshot and this `add` was
      // dropped, and nothing ever fired again. The client now re-fetches on
      // THIS frame, which proves the subscription is live server-side.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'subscribed', id: submissionId }));
      }
    } catch (error: unknown) {
      // `getVisible` throws `AppError(404, 'submission_not_found', …)` for
      // both "does not exist" and "exists but isn't yours" — deliberately
      // the same outcome, so a caller can't use this endpoint as an
      // existence oracle. A transient fault (the database dropping a
      // connection mid-query) is a different thing entirely and must not be
      // dressed up as that same authorization outcome: reported as
      // `submission_not_found`, it reads to the caller as "you have no
      // access", which is simply false, and it would hide a real operational
      // problem behind a code nobody would think to alert on. Distinguish by
      // type, not by content, so the 404-over-403 property above is untouched
      // — only the *unexpected* case gets a different code.
      if (error instanceof AppError) {
        ws.send(JSON.stringify({ type: 'error', code: 'submission_not_found' }));
      } else {
        this.logger.error(describeError(error));
        ws.send(JSON.stringify({ type: 'error', code: 'internal_error' }));
      }
    } finally {
      // Released whatever happened. A reservation kept past a refusal would
      // let a burst of ids the caller may not see spend the whole cap and
      // leave the socket unable to subscribe to anything, ever — a denial of
      // service handed to the client by the bound meant to protect it.
      client.pending.delete(submissionId);
    }
  }

  /**
   * `watch-contest` (D95): enrol this socket in a contest's activity fan-out.
   *
   * **Organiser-only, decided server-side on every frame.** `AuthGuard` never
   * sees a WebSocket, so `assertMayWatch` is the whole of the check — and it
   * is `ContestMonitorService`'s, not this class's, so the socket and the
   * `GET /contests/{key}/monitor` route can never disagree about who runs a
   * contest. Its `AppError` code is forwarded verbatim: `contest_not_found`
   * for a contest this caller may not see and `contest_forbidden` for one
   * they can see but do not run, which is exactly the pair the HTTP route
   * already publishes. Collapsing them here would tell a client less than the
   * route beside it, which is not a security property — only a confusing one.
   */
  private async watchContest(ws: WebSocket, client: Client, key: string): Promise<void> {
    // Re-acked without touching the database — `subscribe`'s rule, and what
    // keeps a client that re-watches on every reconnect from paying for it.
    // Matched case-insensitively because contest keys are (D8's
    // `contests_key_lower_idx`), so a re-watch spelled differently is still
    // the same watch rather than a second one.
    const folded = key.toLowerCase();
    const held = [...client.contests].find((k) => k.toLowerCase() === folded);
    if (held !== undefined) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'contest-watched', key: held }));
      }
      return;
    }

    // A repeat of a watch already being authorized is that same watch.
    // `subscribe`'s rule, folded because contest keys are (D8).
    if (client.pendingContests.has(folded)) return;

    // Checked BEFORE the queries, deliberately: past the cap a flood must
    // cost this process nothing at all. `subscribe`'s reasoning, unchanged —
    // including `pendingContests`, without which a burst of `watch-contest`
    // frames all pass a check on a set none of them has had time to grow.
    if (client.contests.size + client.pendingContests.size >= this.maxContestWatches) {
      ws.send(JSON.stringify({ type: 'error', code: 'contest_watch_limit' }));
      return;
    }

    client.pendingContests.add(folded);
    try {
      const canonical = await this.monitor.assertMayWatch(client.actor, key);
      client.contests.add(canonical);
      // The ack closes the same staleness window `subscribed` does: the page
      // fetches its first snapshot on THIS frame, which proves the watch is
      // live server-side, so no activity between the fetch and the enrolment
      // can be lost.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'contest-watched', key: canonical }));
      }
    } catch (error: unknown) {
      // The same distinction `subscribe` draws, for the same reason: an
      // authorization outcome and a database that dropped a connection are
      // different things, and dressing the second up as the first hides a
      // real operational problem behind a code nobody would alert on.
      if (error instanceof AppError) {
        ws.send(JSON.stringify({ type: 'error', code: error.code }));
      } else {
        this.logger.error(describeError(error));
        ws.send(JSON.stringify({ type: 'error', code: 'internal_error' }));
      }
    } finally {
      // `subscribe`'s `finally`, for `subscribe`'s reason: a refusal —
      // `contest_not_found` on a contest this caller may not see is the
      // common one — must not spend a slot.
      client.pendingContests.delete(folded);
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
    void this.notifyContest(submissionId);
  }

  /**
   * The second half of `notify` (D95): tell every organiser watching this
   * submission's contest that something moved.
   *
   * **The short-circuit is the design.** `judged` publishes one id per state
   * change and knows nothing about contests, so which contest an id belongs
   * to is a lookup — and a lookup on every verdict, forever, to serve a page
   * nobody has open is a cost the ordinary judging path must not pay. So the
   * query runs only when this worker actually holds a watcher. Per worker,
   * deliberately: `main.ts` forks several, every one of them subscribes to
   * the Redis channel, and each answers for its own sockets.
   *
   * The frame carries the contest KEY and nothing else — D23's rule, that a
   * realtime push is a signal and never data. The watcher re-fetches
   * `GET /contests/{key}/monitor`, which re-decides authorization from
   * scratch.
   */
  private async notifyContest(submissionId: number): Promise<void> {
    let watching = false;
    for (const client of this.clients.values()) {
      if (client.contests.size > 0) {
        watching = true;
        break;
      }
    }
    if (!watching) return;

    let key: string | null;
    try {
      key = await this.monitor.contestKeyForSubmission(submissionId);
    } catch (error: unknown) {
      // A wake-up that never arrives costs a watcher one five-second poll.
      // `RedisSubmissionPublisher`'s rule: a realtime path must never make
      // its caller fail, and `notify` is called from the Redis subscriber's
      // message handler, where a rejection would be unhandled.
      this.logger.warn(describeError(error));
      return;
    }
    if (key === null) return;

    const message = JSON.stringify({ type: 'contest-activity', key });
    for (const [ws, client] of this.clients) {
      if (client.contests.has(key) && ws.readyState === WebSocket.OPEN) {
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
 *
 * Two frames are understood. `unsubscribe` is the release half of
 * `subscribe`: without it the only way to stop watching a submission was to
 * drop the connection, which is why `subscriptions` could only ever grow.
 */
/**
 * Four members with four single-literal discriminants, not two with a union
 * discriminant each: TypeScript removes a member from a union only when the
 * check excludes its discriminant entirely, so `{ type: 'watch-contest' |
 * 'unwatch-contest' }` survives both `if`s that handle it and leaves a
 * `key`-only shape in scope where `submissionId` is read.
 */
type ClientMessage =
  | { type: 'subscribe'; submissionId: number }
  | { type: 'unsubscribe'; submissionId: number }
  | { type: 'watch-contest'; key: string }
  | { type: 'unwatch-contest'; key: string };

/** Contest keys, as `CONTEST_KEY` in `@duckoj/contracts` spells them.
 *
 * Restated rather than imported for the reason `JUDGE_SILENCE_SECONDS` is
 * duplicated out of judged: this is a *frame* validator, and its job is to
 * refuse a string that cannot be a key before it reaches a query, not to be
 * the authority on what a key is. A key that passes here and names nothing
 * 404s from `assertMayWatch` exactly as it should. */
const CONTEST_KEY_FRAME = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

function readClientMessage(value: unknown): ClientMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const { type, submissionId, key } = value as {
    type?: unknown;
    submissionId?: unknown;
    key?: unknown;
  };

  if (type === 'watch-contest' || type === 'unwatch-contest') {
    // Shape-checked here rather than in the handler so a 10 000-character
    // `key` can never reach a `lower(key) = lower($1)` comparison, and so a
    // non-string can never reach `.toLowerCase()` — the same crash class
    // `readClientMessage` was written to close.
    if (typeof key !== 'string' || !CONTEST_KEY_FRAME.test(key)) return null;
    if (type === 'watch-contest') return { type, key };
    return { type, key };
  }

  if (type !== 'subscribe' && type !== 'unsubscribe') return null;
  // `Number.isInteger` rather than `typeof === 'number'`: `NaN`, `Infinity`
  // and `1.5` are all numbers, and none of them is a submission id — an id
  // that reaches the Set but can never match a `notify` is a subscription
  // that occupies a slot and can never fire.
  if (!Number.isInteger(submissionId) || (submissionId as number) <= 0) return null;
  const id = submissionId as number;
  if (type === 'subscribe') return { type, submissionId: id };
  return { type, submissionId: id };
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

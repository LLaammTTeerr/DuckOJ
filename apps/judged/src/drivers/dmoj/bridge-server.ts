import { createServer, type Server, type Socket } from 'node:net';
import { describeError } from '@duckoj/observability';
import { createPacketDecoder, encodePacket } from '@duckoj/judge-protocol';
import type { BridgeToJudgePacket, HandshakePacket, JudgeToBridgePacket } from '@duckoj/judge-protocol';

// judge-server sets a 300s read timeout on its end of this socket
// (dmoj/packet.py:104) and expects *us* to send `ping` so it has traffic to
// read. 30s keeps us well under that with plenty of margin for jitter.
export const PING_INTERVAL_MS = 30_000;

// A connection silent for this many ping intervals is presumed dead: the
// judge either crashed or already reconnected on a fresh socket, and this
// old one is a zombie we must stop broadcasting into. Multiple missed
// intervals (not one) tolerates a slow judge under load without either
// side's liveness check racing the other's.
const MISSED_PING_LIMIT = 3;

/**
 * How often a judge's liveness may be written back to `judge_nodes`.
 *
 * `recordLastSeen` used to fire on the handshake and on `ping-response`
 * only — the two signals the design named (§8) — which meant a judge deep in
 * a 30-minute grade wrote nothing for a whole ping interval even though it
 * was demonstrably alive and talking. Every decoded packet is now proof of
 * life (it already was, for the in-memory `lastSeenAt`), but a chatty
 * grading session emits packets per test case, and one UPDATE per test case
 * is a write amplification nobody asked for. So: any packet may refresh it,
 * at most once per window.
 *
 * 15 s is chosen against the reader, not the writer: the admin dashboard
 * calls a judge offline after 90 s of silence (D47), so the freshest value
 * this can be stale by is a sixth of that threshold.
 */
export const LAST_SEEN_THROTTLE_MS = 15_000;

/**
 * How often every connected judge's registration is re-checked against
 * `judge_nodes` (D81).
 *
 * `verifyJudge` runs once, at the handshake, so `judge:node revoke` used to
 * reach only judges that had not connected yet: a revoked judge kept its
 * socket, kept answering pings, and kept being dispatched to — B11 recorded
 * exactly this. Five seconds against a table with one row per machine ever
 * registered, so the poll costs an indexed lookup of a handful of names, and
 * a revocation is honoured well inside ten seconds.
 */
export const REVALIDATE_INTERVAL_MS = 5_000;

export interface BridgeOptions {
  /** Our language key → judge-server executor key. */
  languageToExecutor(languageKey: string): string;
  /**
   * judge-server executor key → our language key, the inverse of
   * `languageToExecutor`. Used to turn what a judge announces in its
   * handshake (`executors`, keyed by DMOJ's names) back into the keys our
   * `languages` table uses, so dispatch can ask "can this judge run cpp17"
   * rather than trusting that every judge runs everything.
   *
   * Defaults to lowercasing, which is exactly the inverse of production's
   * `key.toUpperCase()` mapping — see `main.ts`, where the two directions
   * are written as one pair for that reason. A future language whose
   * executor name is not simply its key uppercased must supply both halves
   * there, not lean on this default.
   */
  executorToLanguage?(executorKey: string): string;
  /**
   * Records what a judge said it can do, from its `handshake` — production
   * wires this to `@duckoj/db`'s `recordJudgeCapabilities`, which writes
   * `judge_nodes.capabilities`. That column existed and was written by
   * nothing (D47's report says so), so an operator could not see which judge
   * ran which language without reading a container's logs.
   *
   * Optional and fire-and-forget on exactly the same terms as
   * `recordLastSeen`: a failure here is an observability gap, never a
   * reason to reject a judge that has already authenticated.
   */
  recordCapabilities?(id: string, capabilities: JudgeCapabilities): Promise<void>;
  /**
   * Verifies the `(id, key)` pair a judge presents in its `handshake` packet
   * against `judge_nodes` — see `@duckoj/db`'s `verifyJudgeCredential`, which
   * production wires this to. Required, not optional: the handshake branch
   * below calls it unconditionally, so a caller cannot construct a
   * `BridgeServer` that accepts a judge without deciding how to verify it.
   */
  verifyJudge(id: string, key: string): Promise<boolean>;
  /**
   * Records that judge `id` is alive — production wires this to
   * `@duckoj/db`'s `touchJudgeLastSeen`, so `judge_nodes.last_seen` reflects
   * what this class's own in-memory `lastSeenAt` map already knows.
   *
   * Called on a successful handshake and thereafter on ANY decoded packet,
   * throttled to one write per `LAST_SEEN_THROTTLE_MS` per judge (D68). It
   * used to fire on the handshake and `ping-response` alone (design §8),
   * which under-reported a judge that was mid-grade and talking constantly;
   * the throttle is what keeps "any packet" from meaning "a write per test
   * case".
   *
   * Optional: every test double that builds `BridgeOptions` without caring
   * about liveness keeps compiling. A rejection or a synchronous throw from
   * this callback is always swallowed at the call site (`touchLastSeen`
   * below) — never allowed to affect the handshake or drop a connection,
   * the same fail-open contract `touchJudgeLastSeen` itself carries.
   */
  recordLastSeen?(id: string): Promise<void>;
  /**
   * Given the ids currently connected, answers which of them are STILL
   * registered and un-revoked — production wires this to `@duckoj/db`'s
   * `admittedJudgeNames` (D81).
   *
   * This exists because `verifyJudge` answers only once, at the handshake:
   * `judge:node revoke` burns a token hash in the database with nothing on
   * this socket to announce it, so a judge revoked while connected kept its
   * connection, and dispatch kept choosing it. Anything connected but missing
   * from this callback's answer is closed and retired.
   *
   * **A rejection is fail-OPEN** — every judge keeps its connection. The
   * query runs against the same database everything else depends on, and
   * evicting the whole fleet on a transient read failure is a fleet-wide
   * outage manufactured out of a blip. The opposite of `verifyJudge`'s
   * fail-closed contract, deliberately: that one would admit an
   * unauthenticated judge, this one would evict authenticated ones.
   *
   * Optional, so every test double and the `NullDriver`-shaped constructions
   * keep compiling; absent, nothing is revalidated and the pre-D81 behaviour
   * stands.
   */
  admittedJudges?(ids: string[]): Promise<string[]>;
  /** Overrides `PING_INTERVAL_MS`. Tests inject a short value; production uses the default. */
  pingIntervalMs?: number;
  /** Overrides `LAST_SEEN_THROTTLE_MS`. Tests inject 0 to observe every write. */
  lastSeenThrottleMs?: number;
  /** Overrides `REVALIDATE_INTERVAL_MS`. Tests inject a short value; production uses the default. */
  revalidateIntervalMs?: number;
}

/**
 * What one judge told us it can do, as stored in `judge_nodes.capabilities`.
 *
 * `concurrency` is 1 and is not read off the wire, because the wire does not
 * carry it: a DMOJ handshake announces executors and problems, and nothing
 * else. One grade per connection is D29's ruling, arrived at from the
 * protocol's own shape, so 1 is what a judge's capacity IS — recorded here
 * as a number an operator can read rather than a fact they have to know.
 */
export interface JudgeCapabilities {
  /** Our language keys, mapped back from the judge's executor names. */
  languages: string[];
  /** The judge's own names for them, unmapped — what it actually said. */
  executors: string[];
  /** Always 1 (D29). See above. */
  concurrency: number;
  /** How many problems it announced. A count, not the list: the list is large and changes constantly. */
  problems: number;
}

export interface JudgeConnection {
  id: string;
  send(packet: BridgeToJudgePacket): void;
  close(): void;
}

type PacketHandler = (connection: JudgeConnection, packet: JudgeToBridgePacket) => void;

/**
 * Called with a judge id the moment its registered connection leaves
 * `connections` for any reason other than this server shutting down.
 *
 * Whoever is grading on that socket has to hear about it. Before this
 * existed the `close` handler quietly deleted the map entries and told the
 * driver nothing, so a judge that died mid-grade left `DmojDriver` holding a
 * live job and `Worker` parked on a terminal event that would never come —
 * until the grading ceiling fired, minutes later.
 */
type DisconnectHandler = (id: string) => void;

/**
 * The TCP listener judges connect *out* to. judge-server dials us, not the
 * reverse — so `judged` must be reachable from the judge container, and
 * needs no ingress of its own.
 */
export class BridgeServer {
  private server: Server | undefined;
  private readonly connections = new Map<string, JudgeConnection>();
  /** Last time each connection produced a decoded packet — any packet, not just `ping-response`. */
  private readonly lastSeenAt = new Map<string, number>();
  /**
   * The problem set each judge last announced, from its `handshake` and any
   * later `supported-problems` packet. Replaced wholesale on each
   * announcement, never merged — a judge that dropped a package must not
   * appear to still have it. Scheduling picks a connection by *idleness*
   * (`DmojDriver`), not by problem set; this is what would let a later phase
   * verify a dispatch against what the judge believes, rather than merely
   * trusting it.
   */
  private readonly problemSets = new Map<string, Set<string>>();
  /**
   * The executor set each judge announced in its `handshake` — DMOJ's own
   * names (`CPP17`, …), not ours. This is what makes a heterogeneous fleet
   * possible: `DmojDriver` dispatches a job only to a connection whose set
   * contains the executor its language maps to.
   *
   * Handshake-only, unlike `problemSets`: judge-server announces problems
   * again whenever they change (`supported-problems`) but never re-announces
   * executors, so a judge that gains one has to reconnect for us to know —
   * which it does anyway, since executors are configured at startup.
   */
  private readonly executorSets = new Map<string, Set<string>>();
  /** When `recordLastSeen` last fired for each judge — the throttle's clock. */
  private readonly lastRecordedAt = new Map<string, number>();
  private handler: PacketHandler = () => {};
  private disconnectHandler: DisconnectHandler = () => {};
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private revalidateTimer: ReturnType<typeof setInterval> | undefined;
  /** True while a revalidation query is in flight, so a slow one cannot stack up. */
  private revalidating = false;
  private readonly pingIntervalMs: number;
  private readonly lastSeenThrottleMs: number;
  private readonly revalidateIntervalMs: number;

  constructor(readonly options: BridgeOptions) {
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.lastSeenThrottleMs = options.lastSeenThrottleMs ?? LAST_SEEN_THROTTLE_MS;
    this.revalidateIntervalMs = options.revalidateIntervalMs ?? REVALIDATE_INTERVAL_MS;
  }

  /** Our language key for one of the judge's executor names. */
  private toLanguage(executorKey: string): string {
    return this.options.executorToLanguage?.(executorKey) ?? executorKey.toLowerCase();
  }

  onPacket(handler: PacketHandler): void {
    this.handler = handler;
  }

  /**
   * Registers the one handler told when a registered judge connection goes
   * away — a FIN or reset, a connection reaped by `sweep()` for silence, or
   * one displaced by the same judge redialling.
   *
   * Deliberately NOT fired from `close()`: that is this process shutting the
   * bridge down on purpose, and its callers (`DmojDriver.stop`) are already
   * tearing everything down. Firing there would report every judge as having
   * abandoned its work on the way out, which would requeue jobs that are
   * about to be requeued anyway by a cleaner path.
   */
  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandler = handler;
  }

  /**
   * Drops one registered connection and reports it, in that order — the
   * handler must observe the map as it will be, not as it was, because
   * `DmojDriver` reacts by looking for another judge to take the work.
   */
  private retire(id: string): void {
    this.connections.delete(id);
    this.lastSeenAt.delete(id);
    this.problemSets.delete(id);
    this.executorSets.delete(id);
    // Not carried across a reconnect: the fresh handshake must be free to
    // write `last_seen` immediately, or a judge that flapped inside the
    // throttle window would look silent for another window.
    this.lastRecordedAt.delete(id);
    this.disconnectHandler(id);
  }

  judgeCount(): number {
    return this.connections.size;
  }

  /** The problem set the given judge id last announced. Empty for an unknown or silent judge. */
  problemsFor(id: string): ReadonlySet<string> {
    return this.problemSets.get(id) ?? new Set();
  }

  /**
   * The executor set the given judge announced at handshake — DMOJ's names.
   * Empty for an unknown judge, which is the safe answer: a connection we
   * know nothing about supports nothing, so nothing is dispatched to it.
   */
  executorsFor(id: string): ReadonlySet<string> {
    return this.executorSets.get(id) ?? new Set();
  }

  /**
   * Every language key the connected fleet can grade right now, deduplicated
   * — the union of each judge's executors mapped back through
   * `executorToLanguage`. Empty when no judge is connected, which is
   * literally true and is what stops a claim loop taking work nothing can run.
   */
  supportedLanguages(): string[] {
    const languages = new Set<string>();
    for (const id of this.connections.keys()) {
      for (const executor of this.executorsFor(id)) languages.add(this.toLanguage(executor));
    }
    return [...languages];
  }

  /**
   * Fires `options.recordLastSeen` for `id`, if the caller supplied one,
   * without ever letting it affect the caller. `Promise.resolve().then(...)`
   * catches a synchronous throw from a test double the same way it would
   * catch an async rejection from the real implementation — both land in
   * the same `catch`, which does nothing on purpose (see `recordLastSeen`'s
   * doc comment).
   */
  private touchLastSeen(id: string): void {
    const record = this.options.recordLastSeen;
    if (!record) return;
    this.lastRecordedAt.set(id, Date.now());
    void Promise.resolve()
      .then(() => record(id))
      .catch(() => {
        // Observability only. Never rejects a handshake or drops a heartbeat.
      });
  }

  /**
   * `touchLastSeen`, but at most once per `lastSeenThrottleMs` for this
   * judge. The clock is stamped by `touchLastSeen` itself, so the handshake's
   * unthrottled write also opens the window rather than being immediately
   * followed by a second one.
   */
  private touchLastSeenThrottled(id: string): void {
    const last = this.lastRecordedAt.get(id);
    if (last !== undefined && Date.now() - last < this.lastSeenThrottleMs) return;
    this.touchLastSeen(id);
  }

  /**
   * Records a judge's announced capabilities, fire-and-forget on exactly the
   * terms `touchLastSeen` uses — a synchronous throw from a double and an
   * async rejection from the real implementation land in the same empty
   * `catch`, and neither can affect the handshake.
   */
  private recordCapabilities(id: string, handshake: HandshakePacket): void {
    const record = this.options.recordCapabilities;
    if (!record) return;
    const executors = Object.keys(handshake.executors);
    const capabilities: JudgeCapabilities = {
      languages: [...new Set(executors.map((executor) => this.toLanguage(executor)))],
      executors,
      // D29: one grade per connection. The handshake carries no such field.
      concurrency: 1,
      problems: handshake.problems.length,
    };
    void Promise.resolve()
      .then(() => record(id, capabilities))
      .catch(() => {
        // Observability only. See the doc comment on `recordCapabilities`.
      });
  }

  /**
   * Sends to EVERY connected judge.
   *
   * Deliberately not used for anything carrying a submission: DMOJ's
   * `terminate-submission` has no submission id
   * (`packages/judge-protocol/src/dmoj-packets.ts`), so broadcasting one kills
   * whatever each judge happens to be running — which is how B2 turned one
   * job's watchdog into another student's permanent IE. Per-submission
   * traffic goes through `sendTo`, addressed to the connection the driver
   * knows is grading it. This stays for genuinely fleet-wide packets and for
   * the tests that exercise reachability.
   */
  broadcast(packet: BridgeToJudgePacket): void {
    for (const connection of this.connections.values()) connection.send(packet);
  }

  /**
   * Sends to exactly one judge. Returns false when that judge is no longer
   * connected, so a caller can tell "delivered" from "there was nobody to
   * deliver to" rather than assuming the packet landed.
   */
  sendTo(id: string, packet: BridgeToJudgePacket): boolean {
    const connection = this.connections.get(id);
    if (!connection) return false;
    connection.send(packet);
    return true;
  }

  /**
   * The ids of every currently connected judge, in the order they handshook.
   * This is what lets the driver pick a connection to dispatch on instead of
   * shouting at all of them.
   */
  connectionIds(): string[] {
    return [...this.connections.keys()];
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.accept(socket));
      // Without this, a startup failure (e.g. EADDRINUSE) leaves the promise
      // pending forever instead of surfacing the actual cause.
      const onListenError = (error: Error): void => reject(error);
      this.server.once('error', onListenError);
      this.server.listen(port, '0.0.0.0', () => {
        this.server!.off('error', onListenError);
        const address = this.server!.address();
        this.pingTimer = setInterval(() => this.sweep(), this.pingIntervalMs);
        if (this.options.admittedJudges) {
          this.revalidateTimer = setInterval(() => void this.revalidate(), this.revalidateIntervalMs);
        }
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  /**
   * Pings every live connection and drops whichever ones have gone silent
   * for `MISSED_PING_LIMIT` intervals. This is the check that actually
   * prevents a lost dispatch: without it, a connection the judge has
   * already abandoned (its 300s read timeout fired, it reconnected on a
   * fresh socket) stays in `this.connections` forever, and `broadcast()`
   * keeps writing into a socket nobody on the other end is reading.
   */
  private sweep(): void {
    const now = Date.now();
    for (const [id, connection] of this.connections) {
      const lastSeen = this.lastSeenAt.get(id) ?? now;
      if (now - lastSeen > this.pingIntervalMs * MISSED_PING_LIMIT) {
        connection.close();
        // `retire`, not three deletes: the socket's own `close` handler will
        // find the connection already gone from the map and stay silent, so
        // this is the only place the disconnect can be reported for a reaped
        // judge — and a judge silent for three ping intervals is exactly the
        // one whose in-flight grade will never finish.
        this.retire(id);
        continue;
      }
      connection.send({ name: 'ping', when: Math.floor(Date.now() / 1000) });
    }
  }

  /**
   * Re-checks every connected judge against the registration table and drops
   * whichever ones are no longer admitted (D81).
   *
   * `sweep`'s sibling, and deliberately a separate timer: silence and
   * revocation are different signals on different clocks — a judge answering
   * every ping is exactly the one this must be able to disconnect, and
   * folding the check into the ping loop would tie a five-second revocation
   * budget to a thirty-second liveness interval.
   *
   * Three rules, each of which is a way this could go wrong instead:
   *
   * - **Nothing connected, nothing asked.** An idle bridge must not run a
   *   query twelve times a minute to be told about no judges.
   * - **Never two at once.** A slow query under a stacked timer would queue
   *   one connection per tick against the database it is already struggling
   *   to reach.
   * - **A throw changes nothing.** See `BridgeOptions.admittedJudges`.
   */
  private async revalidate(): Promise<void> {
    const check = this.options.admittedJudges;
    if (!check) return;
    if (this.revalidating) return;
    const ids = [...this.connections.keys()];
    if (ids.length === 0) return;
    this.revalidating = true;
    try {
      const admitted = new Set(await check(ids));
      for (const id of ids) {
        if (admitted.has(id)) continue;
        // Re-read from the map: the answer is about the connection that was
        // there when the query was issued, and a judge that redialled while
        // it was in flight has a *new* connection under this id which this
        // answer says nothing about. Closing that one would disconnect a
        // judge on the strength of a stale reply.
        const connection = this.connections.get(id);
        if (!connection) continue;
        console.warn(
          JSON.stringify({ msg: 'dropping revoked judge', id }),
        );
        connection.close();
        // `retire`, not a bare delete — whoever is grading on that socket
        // has to hear about it, exactly as for a judge that died.
        this.retire(id);
      }
    } catch (error) {
      // Fail OPEN, and say so once per failed poll rather than silently: an
      // operator who revoked a judge and watched nothing happen needs this
      // line to tell "the poll is broken" from "the poll disagrees".
      console.error(
        JSON.stringify({ msg: 'judge revalidation failed', error: describeError(error) }),
      );
    } finally {
      this.revalidating = false;
    }
  }

  private accept(socket: Socket): void {
    let id: string | undefined;
    const connection: JudgeConnection = {
      get id() {
        return id ?? 'unidentified';
      },
      send: (packet) => socket.write(encodePacket(packet)),
      close: () => socket.destroy(),
    };

    const decoder = createPacketDecoder({
      onPacket: (value) => {
        const packet = value as JudgeToBridgePacket;
        if (packet.name === 'handshake') {
          const handshake = packet;
          // `verifyJudge` is async but `onPacket` is a synchronous callback
          // (the decoder's `push()` loop drains every packet buffered in the
          // current chunk before returning), so the check runs detached in
          // an IIFE rather than blocking decode of whatever follows it.
          void (async () => {
            let verified: boolean;
            let verificationError: unknown;
            try {
              verified = await this.options.verifyJudge(handshake.id, handshake.key);
            } catch (error) {
              // A verification failure (e.g. a database blip) must fail
              // closed: an unverifiable judge is an unauthenticated judge,
              // never an admitted one.
              verified = false;
              verificationError = error;
            }
            // The socket may have been destroyed (by teardown, or the
            // remote end dropping) while verification was in flight;
            // touching `this.connections` for a dead socket would register
            // a connection `broadcast()` can never actually reach.
            if (socket.destroyed) return;
            if (!verified) {
              // Send nothing on the wire — no `handshake-success`, no error
              // packet — just a closed connection, and `this.connections`
              // is never touched. But say *something* on the operator side:
              // without this, a `judge_nodes` seeding gap or a mistyped key
              // produces a connect/reject/retry loop with no line anywhere
              // explaining why, and "the judge never connects" is not
              // greppable.
              //
              // One line, not two, and it never distinguishes "unknown
              // judge" from "wrong key" — that distinction is exactly what
              // would let someone probing judge names learn which ones are
              // registered. `id` is safe to log: it is already the value
              // the caller sent in cleartext, so echoing it back tells an
              // operator (or an attacker) nothing new. The key never
              // appears here. A thrown verifier, though, *is* worth telling
              // apart from a plain rejection — it is an outage, not a bad
              // credential — so `reason` and a redacted `describeError`
              // (constructor name, driver code, stack frames only — no
              // query text, no bind parameters) cover that case without
              // ever touching the raw error message, which could echo the
              // key back if a verifier's own error text embedded it.
              console.error(
                JSON.stringify({
                  msg: 'judge handshake rejected',
                  id: handshake.id,
                  ...(verificationError
                    ? { reason: 'verification error', error: describeError(verificationError) }
                    : { reason: 'credential rejected' }),
                }),
              );
              socket.destroy();
              return;
            }
            id = handshake.id;
            // A judge reconnecting with an id already in the map (e.g. it
            // dropped the old socket and redialed before we noticed) must not
            // silently evict the live connection: `set()` alone leaves the old
            // socket open and out of `connections`, so `sweep()` never pings or
            // reaps it, and its eventual FIN — landing on a `close` handler
            // captured with this same `id` — would delete whatever now sits at
            // `id`, which by then is the new, live connection. Closing the old
            // socket here retires it immediately and deterministically, rather
            // than leaving that eviction to race an unrelated close event.
            const displaced = this.connections.get(id);
            if (displaced && displaced !== connection) {
              displaced.close();
              // Reported before the new socket takes the slot, for the same
              // reason `sweep` reports its own reap: the displaced socket's
              // `close` handler will see a different connection under `id`
              // and stay silent, so this is the only chance to say that
              // whatever it was grading died with it. The driver's own
              // `handshake` branch below then finds nothing stale left to
              // release.
              this.retire(id);
            }
            this.connections.set(id, connection);
            // AFTER the displacement above, never before it: `retire` clears
            // both of these maps for `id`, so announcing this connection's
            // problems and executors first meant a redialling judge wiped its
            // OWN freshly-recorded sets and came back looking like a judge
            // that can run nothing. Harmless while `problemSets` fed nothing;
            // fatal for `executorSets`, which dispatch reads (D68) — a
            // reconnected judge would never be sent another job.
            //
            // Still before `handshake-success` and before `this.handler`,
            // which is what wakes parked dispatches: one of them may pick
            // this connection the moment it is woken, and must not observe it
            // as having no executors.
            this.problemSets.set(id, new Set(handshake.problems.map(([problemId]) => problemId)));
            this.executorSets.set(id, new Set(Object.keys(handshake.executors)));
            connection.send({ name: 'handshake-success' });
            this.lastSeenAt.set(id, Date.now());
            this.touchLastSeen(id);
            this.recordCapabilities(id, handshake);
            this.handler(connection, packet);
          })();
          return;
        }
        // A packet arriving before the handshake has finished verifying
        // (e.g. batched into the same TCP chunk) belongs to a connection
        // that is not yet authenticated — and may never be, since
        // verification is still pending. Dropping it here, rather than
        // forwarding to `this.handler`, closes the gap the async check
        // above would otherwise leave open: an unverified socket must not
        // be able to inject grading packets just by arriving fast enough.
        if (!id) return;
        // Any decoded packet is proof the judge on the other end is still
        // reading and writing — not just `ping-response`.
        this.lastSeenAt.set(id, Date.now());
        // The durable `judge_nodes.last_seen` write now follows `lastSeenAt`
        // rather than only `ping-response`: a judge two minutes into a grade
        // is streaming test-case packets and is obviously alive, and there
        // was no reason for the dashboard to be told otherwise. The throttle
        // (D68) is what keeps "any packet" from becoming a write per test
        // case.
        this.touchLastSeenThrottled(id);
        if (packet.name === 'supported-problems') {
          this.problemSets.set(id, new Set(packet.problems.map(([problemId]) => problemId)));
        }
        this.handler(connection, packet);
      },
      // A malformed frame means we can no longer trust the stream position,
      // so the connection is dropped rather than resynchronised.
      onError: () => socket.destroy(),
    });

    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('close', () => {
      // Identity check, not just presence: this handler is captured per
      // connection, so a socket that was displaced by a same-id reconnect
      // (see the handshake handler above) must only remove itself from the
      // map — never the connection that replaced it, which is what an
      // unguarded `delete(id)` would do if this stale socket's FIN arrives
      // after the new one has already taken `id`'s slot.
      if (id && this.connections.get(id) === connection) {
        this.retire(id);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  async close(): Promise<void> {
    // An uncleared interval holds the event loop open — without this,
    // `judged` would refuse to exit even after every connection and the
    // server socket itself are gone.
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    this.revalidateTimer = undefined;
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.lastSeenAt.clear();
    this.problemSets.clear();
    this.executorSets.clear();
    this.lastRecordedAt.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

import { createServer, type Server, type Socket } from 'node:net';
import { describeError } from '@duckoj/observability';
import { createPacketDecoder, encodePacket } from '@duckoj/judge-protocol';
import type { BridgeToJudgePacket, JudgeToBridgePacket } from '@duckoj/judge-protocol';

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

export interface BridgeOptions {
  /** Our language key → judge-server executor key. */
  languageToExecutor(languageKey: string): string;
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
   * Called on a successful handshake and on every `ping-response`, the
   * design's two specified signals (design §8) — never on every packet,
   * unlike `lastSeenAt`, so a chatty grading session cannot turn liveness
   * tracking into a write on every packet.
   *
   * Optional: every test double that builds `BridgeOptions` without caring
   * about liveness keeps compiling. A rejection or a synchronous throw from
   * this callback is always swallowed at the call site (`touchLastSeen`
   * below) — never allowed to affect the handshake or drop a connection,
   * the same fail-open contract `touchJudgeLastSeen` itself carries.
   */
  recordLastSeen?(id: string): Promise<void>;
  /** Overrides `PING_INTERVAL_MS`. Tests inject a short value; production uses the default. */
  pingIntervalMs?: number;
}

export interface JudgeConnection {
  id: string;
  send(packet: BridgeToJudgePacket): void;
  close(): void;
}

type PacketHandler = (connection: JudgeConnection, packet: JudgeToBridgePacket) => void;

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
  private handler: PacketHandler = () => {};
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pingIntervalMs: number;

  constructor(readonly options: BridgeOptions) {
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  }

  onPacket(handler: PacketHandler): void {
    this.handler = handler;
  }

  judgeCount(): number {
    return this.connections.size;
  }

  /** The problem set the given judge id last announced. Empty for an unknown or silent judge. */
  problemsFor(id: string): ReadonlySet<string> {
    return this.problemSets.get(id) ?? new Set();
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
    void Promise.resolve()
      .then(() => record(id))
      .catch(() => {
        // Observability only. Never rejects a handshake or drops a heartbeat.
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
        this.connections.delete(id);
        this.lastSeenAt.delete(id);
        this.problemSets.delete(id);
        continue;
      }
      connection.send({ name: 'ping', when: Math.floor(Date.now() / 1000) });
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
            this.problemSets.set(id, new Set(handshake.problems.map(([problemId]) => problemId)));
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
            if (displaced && displaced !== connection) displaced.close();
            this.connections.set(id, connection);
            connection.send({ name: 'handshake-success' });
            this.lastSeenAt.set(id, Date.now());
            this.touchLastSeen(id);
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
        // Unlike `lastSeenAt` above, the durable `judge_nodes.last_seen`
        // write only fires on `ping-response` — the actual heartbeat the
        // design specifies (§8) — not on every packet a busy grading
        // session produces.
        if (packet.name === 'ping-response') {
          this.touchLastSeen(id);
        }
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
        this.connections.delete(id);
        this.lastSeenAt.delete(id);
        this.problemSets.delete(id);
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
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.lastSeenAt.clear();
    this.problemSets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

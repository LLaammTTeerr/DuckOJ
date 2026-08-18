import { createServer, type Server, type Socket } from 'node:net';
import { createPacketDecoder, encodePacket } from '@qhhoj/judge-protocol';
import type { BridgeToJudgePacket, JudgeToBridgePacket } from '@qhhoj/judge-protocol';

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
  /** Content hash → on-disk problem code. This is where the DMOJ-ism stops. */
  hashToProblemCode(packageHash: string): string;
  /** Our language key → judge-server executor key. */
  languageToExecutor(languageKey: string): string;
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

  /** Sends to any connected judge. Phase 1 has exactly one. */
  broadcast(packet: BridgeToJudgePacket): void {
    for (const connection of this.connections.values()) connection.send(packet);
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
          id = packet.id;
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
        }
        // Any decoded packet is proof the judge on the other end is still
        // reading and writing — not just `ping-response`. Recorded after
        // `id` is assigned above, so a handshake and a packet that follows
        // it in the same TCP chunk both land against the right id.
        if (id) this.lastSeenAt.set(id, Date.now());
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
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

import { createServer, type Server, type Socket } from 'node:net';
import { createPacketDecoder, encodePacket } from '@qhhoj/judge-protocol';
import type { BridgeToJudgePacket, JudgeToBridgePacket } from '@qhhoj/judge-protocol';

export interface BridgeOptions {
  /** Content hash → on-disk problem code. This is where the DMOJ-ism stops. */
  hashToProblemCode(packageHash: string): string;
  /** Our language key → judge-server executor key. */
  languageToExecutor(languageKey: string): string;
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
  private handler: PacketHandler = () => {};

  constructor(readonly options: BridgeOptions) {}

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
    return new Promise((resolve) => {
      this.server = createServer((socket) => this.accept(socket));
      this.server.listen(port, '0.0.0.0', () => {
        const address = this.server!.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
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
          this.connections.set(id, connection);
          connection.send({ name: 'handshake-success' });
        }
        this.handler(connection, packet);
      },
      // A malformed frame means we can no longer trust the stream position,
      // so the connection is dropped rather than resynchronised.
      onError: () => socket.destroy(),
    });

    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('close', () => {
      if (id) this.connections.delete(id);
    });
    socket.on('error', () => socket.destroy());
  }

  async close(): Promise<void> {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

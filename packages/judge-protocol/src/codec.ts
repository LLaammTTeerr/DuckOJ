import { deflateSync, inflateSync } from 'node:zlib';

/**
 * DMOJ frames every packet as a 4-byte big-endian length followed by
 * zlib-compressed UTF-8 JSON. Verified against judge-server's
 * `dmoj/packet.py` (`SIZE_PACK = struct.Struct('!I')`, `zlib.compress`)
 * and the bridge's `base_handler.py`.
 */
const HEADER_BYTES = 4;

/** Matches judge-server's own cap. A larger declared size is a protocol error. */
export const MAX_PACKET_SIZE = 64 * 1024 * 1024;

export function encodePacket(value: unknown): Buffer {
  const body = deflateSync(Buffer.from(JSON.stringify(value), 'utf8'));
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export interface PacketDecoderOptions {
  onPacket(value: unknown): void;
  /** Called for a malformed frame. The caller decides whether to drop the connection. */
  onError(error: Error): void;
}

export interface PacketDecoder {
  push(chunk: Buffer): void;
}

export function createPacketDecoder(options: PacketDecoderOptions): PacketDecoder {
  let buffered: Buffer = Buffer.alloc(0);
  let poisoned = false;

  return {
    push(chunk: Buffer): void {
      if (poisoned) return;
      buffered = buffered.length === 0 ? chunk : (Buffer.concat([buffered, chunk]) as Buffer);

      for (;;) {
        if (buffered.length < HEADER_BYTES) return;
        const size = buffered.readUInt32BE(0);

        // Checked before allocating: a hostile or corrupt header must not be
        // able to make us reserve gigabytes waiting for a body that never comes.
        if (size > MAX_PACKET_SIZE) {
          poisoned = true;
          options.onError(new Error(`packet too large: ${size} bytes`));
          return;
        }

        if (buffered.length < HEADER_BYTES + size) return;

        const body = buffered.subarray(HEADER_BYTES, HEADER_BYTES + size);
        buffered = buffered.subarray(HEADER_BYTES + size);

        try {
          options.onPacket(JSON.parse(inflateSync(body).toString('utf8')));
        } catch (error) {
          poisoned = true;
          options.onError(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    },
  };
}

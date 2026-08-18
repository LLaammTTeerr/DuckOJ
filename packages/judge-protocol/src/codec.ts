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
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let poisoned = false;

  // Read N bytes from offset in the chunks array, materializing only what's needed
  function readBytes(offset: number, length: number): Buffer {
    const result: Buffer[] = [];
    let currentPos = 0;

    for (const chunk of chunks) {
      if (currentPos + chunk.length <= offset) {
        // This chunk is before our read range
        currentPos += chunk.length;
        continue;
      }

      if (currentPos >= offset + length) {
        // We've read enough
        break;
      }

      // This chunk overlaps with our read range
      const chunkStart = Math.max(0, offset - currentPos);
      const chunkEnd = Math.min(chunk.length, offset + length - currentPos);
      result.push(chunk.subarray(chunkStart, chunkEnd));
      currentPos += chunk.length;
    }

    return Buffer.concat(result);
  }

  // Consume N bytes from the front of the chunks array
  function consumeBytes(count: number): void {
    let remaining = count;
    while (remaining > 0 && chunks.length > 0) {
      const chunk = chunks[0]!;
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
        chunks.shift();
      } else {
        chunks[0] = chunk.subarray(remaining);
        remaining = 0;
      }
    }
    totalBytes -= count;
  }

  return {
    push(chunk: Buffer): void {
      if (poisoned) return;

      chunks.push(chunk);
      totalBytes += chunk.length;

      for (;;) {
        if (totalBytes < HEADER_BYTES) return;

        const headerBuf = readBytes(0, HEADER_BYTES);
        const size = headerBuf.readUInt32BE(0);

        // Checked before allocating: a hostile or corrupt header must not be
        // able to make us reserve gigabytes waiting for a body that never comes.
        if (size > MAX_PACKET_SIZE) {
          poisoned = true;
          options.onError(new Error(`packet too large: ${size} bytes`));
          return;
        }

        if (totalBytes < HEADER_BYTES + size) return;

        const body = readBytes(HEADER_BYTES, size);
        consumeBytes(HEADER_BYTES + size);

        // Decoding (inflate + JSON.parse) is the only thing that can prove
        // the *stream* is corrupt, so it is the only thing this try/catch
        // covers. `options.onPacket` runs the caller's own logic — in
        // `BridgeServer`, that includes application code with no relation to
        // frame integrity — and a throw from *it* is not evidence the wire
        // format is broken. Catching it here and routing it through the same
        // `onError` (which every caller wires to "drop the connection") would
        // destroy a perfectly healthy connection over a bug in the handler.
        // Left uncaught, it propagates out of this `push()` call instead,
        // without setting `poisoned` — so a later `push()` (the next chunk,
        // possibly the next packet in this one) still decodes normally.
        let decoded: unknown;
        try {
          decoded = JSON.parse(inflateSync(body).toString('utf8'));
        } catch (error) {
          poisoned = true;
          options.onError(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        options.onPacket(decoded);
      }
    },
  };
}

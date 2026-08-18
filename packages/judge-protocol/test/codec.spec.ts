import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { MAX_PACKET_SIZE, createPacketDecoder, encodePacket } from '../src/index.js';

function framesOf(...values: unknown[]): Buffer {
  return Buffer.concat(values.map((v) => encodePacket(v)));
}

describe('packet codec', () => {
  it('round-trips a packet', () => {
    const onPacket = vi.fn();
    const decoder = createPacketDecoder({ onPacket, onError: vi.fn() });

    decoder.push(encodePacket({ name: 'handshake-success' }));

    expect(onPacket).toHaveBeenCalledWith({ name: 'handshake-success' });
  });

  it('uses a 4-byte big-endian length prefix over zlib-compressed JSON', () => {
    const frame = encodePacket({ name: 'ping', when: 1 });
    const declared = frame.readUInt32BE(0);
    const expectedBody = deflateSync(Buffer.from(JSON.stringify({ name: 'ping', when: 1 }), 'utf8'));

    expect(frame.length).toBe(4 + declared);
    expect(frame.subarray(4)).toEqual(expectedBody);
  });

  it('decodes several packets arriving in one chunk', () => {
    const onPacket = vi.fn();
    const decoder = createPacketDecoder({ onPacket, onError: vi.fn() });

    decoder.push(framesOf({ name: 'a' }, { name: 'b' }, { name: 'c' }));

    expect(onPacket.mock.calls.map(([p]) => (p as { name: string }).name)).toEqual(['a', 'b', 'c']);
  });

  it('decodes one packet split across arbitrary chunk boundaries', () => {
    const onPacket = vi.fn();
    const decoder = createPacketDecoder({ onPacket, onError: vi.fn() });
    const frame = encodePacket({ name: 'grading-end', 'submission-id': 42 });

    for (const byte of frame) decoder.push(Buffer.from([byte]));

    expect(onPacket).toHaveBeenCalledWith({ name: 'grading-end', 'submission-id': 42 });
  });

  it('reports an error for a frame that is not valid zlib', () => {
    const onError = vi.fn();
    const decoder = createPacketDecoder({ onPacket: vi.fn(), onError });
    const garbage = Buffer.from('not zlib at all');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(garbage.length, 0);

    decoder.push(Buffer.concat([header, garbage]));

    expect(onError).toHaveBeenCalled();
  });

  it('rejects a declared size beyond the cap without allocating it', () => {
    const onError = vi.fn();
    const decoder = createPacketDecoder({ onPacket: vi.fn(), onError });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_PACKET_SIZE + 1, 0);

    decoder.push(header);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('too large') }));
  });

  it('correctly decodes a large packet split into many small chunks', () => {
    const onPacket = vi.fn();
    const decoder = createPacketDecoder({ onPacket, onError: vi.fn() });

    // Create a payload with incompressible data (random bytes as base64)
    // so the compressed frame stays large enough to be split across chunks
    const payload = { name: 'large-test', data: randomBytes(4000).toString('base64') };
    const frame = encodePacket(payload);

    // Split the frame into small chunks (128 bytes each) to simulate streaming
    const chunkSize = 128;
    const chunkCount = Math.ceil(frame.length / chunkSize);

    // Assert we actually split into many chunks; this guards against payload changes
    // that recompress too well. Current value ~32; threshold of 20 leaves headroom for
    // random-content variance while catching any serious regression.
    expect(chunkCount).toBeGreaterThanOrEqual(20);

    for (let i = 0; i < frame.length; i += chunkSize) {
      decoder.push(frame.subarray(i, Math.min(i + chunkSize, frame.length)));
    }

    expect(onPacket).toHaveBeenCalledWith(payload);
  });

  it('does not treat a throwing handler as a corrupt stream', () => {
    const onError = vi.fn();
    let calls = 0;
    const onPacket = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error('handler bug, unrelated to the wire format');
    });
    const decoder = createPacketDecoder({ onPacket, onError });

    // The first packet's handler throws. This must not be mistaken for a
    // malformed frame: `onError` (which every real caller wires to
    // `socket.destroy()`) must never fire for it, and the decoder must not
    // poison itself — a healthy connection must survive one buggy handler
    // invocation and keep decoding whatever arrives next.
    expect(() => decoder.push(encodePacket({ name: 'a' }))).toThrow('handler bug');
    expect(onError).not.toHaveBeenCalled();

    decoder.push(encodePacket({ name: 'b' }));
    expect(onPacket).toHaveBeenCalledTimes(2);
    expect(onPacket).toHaveBeenLastCalledWith({ name: 'b' });
    expect(onError).not.toHaveBeenCalled();
  });
});

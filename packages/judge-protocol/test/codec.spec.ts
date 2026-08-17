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

    // Create a payload with repeated data to make it reasonably large when compressed
    const payload = { name: 'large-test', data: 'x'.repeat(5000) };
    const frame = encodePacket(payload);

    // Split the frame into small chunks (64 bytes each) to simulate streaming
    const chunkSize = 64;
    for (let i = 0; i < frame.length; i += chunkSize) {
      decoder.push(frame.subarray(i, Math.min(i + chunkSize, frame.length)));
    }

    expect(onPacket).toHaveBeenCalledWith(payload);
  });
});

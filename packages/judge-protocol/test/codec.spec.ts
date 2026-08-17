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

    expect(frame.length).toBe(4 + declared);
    expect(deflateSync(Buffer.from(JSON.stringify({ name: 'ping', when: 1 }), 'utf8')).length).toBe(
      declared,
    );
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
});

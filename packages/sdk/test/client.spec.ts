import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

describe('createClient', () => {
  it('resolves paths against the configured base url', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = createClient({ baseUrl: 'http://api.test/api/v1', fetch: fetchMock });

    await client.GET('/auth/me');

    const req = fetchMock.mock.calls[0]?.[0] as Request;
    expect(req.url).toBe('http://api.test/api/v1/auth/me');
  });

  it('attaches a bearer token when one is supplied', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = createClient({
      baseUrl: 'http://api.test/api/v1',
      token: 'qhh_abc',
      fetch: fetchMock,
    });

    await client.GET('/auth/me');

    const req = fetchMock.mock.calls[0]?.[0] as Request;
    expect(req.headers.get('authorization')).toBe('Bearer qhh_abc');
  });
});

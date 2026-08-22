import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

/**
 * Narrows what `fetch` was actually called with.
 *
 * `openapi-fetch` builds a `Request` and passes it as the sole argument, but
 * the `fetch` signature admits a string or a URL too. Asserting that here
 * checks the assumption the tests below rest on, rather than casting past it.
 */
function requireRequest(input: RequestInfo | URL): Request {
  if (!(input instanceof Request)) {
    throw new Error(`expected fetch to be called with a Request, got ${typeof input}`);
  }
  return input;
}

describe('createClient', () => {
  it('resolves paths against the configured base url', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    const client = createClient({ baseUrl: 'http://api.test/api/v1', fetch: fetchMock });

    await client.GET('/auth/me');

    const req = requireRequest(fetchMock.mock.calls[0]![0]);
    expect(req.url).toBe('http://api.test/api/v1/auth/me');
  });

  it('attaches a bearer token when one is supplied', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    const client = createClient({
      baseUrl: 'http://api.test/api/v1',
      token: 'duck_abc',
      fetch: fetchMock,
    });

    await client.GET('/auth/me');

    const req = requireRequest(fetchMock.mock.calls[0]![0]);
    expect(req.headers.get('authorization')).toBe('Bearer duck_abc');
  });
});

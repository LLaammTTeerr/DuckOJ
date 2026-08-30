/**
 * One doubled `fetch` behind the real SDK client.
 *
 * The seam is `ClientOptions.fetch` rather than a doubled `client` object,
 * deliberately: what these tests are pinning is the REQUEST each tool makes —
 * the method, the path, the query string, the body — and a doubled `client`
 * would let a tool call `GET('/problmes')` and still pass, because the double
 * answers whatever it is asked. Going through `createClient` means the
 * generated types and the real path templating are both in the loop.
 */
import { createClient } from '@duckoj/sdk';
import type { Client, ToolContext } from '../src/tool.js';

export const BASE_URL = 'https://oj.test/api/v1';

export interface Stub {
  client: Client;
  /** Every request the tools made, newest last. */
  calls: Request[];
  last: () => Request;
}

export type Responder = (request: Request) => Response | Promise<Response>;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function problem(
  status: number,
  body: { code: string; title?: string; detail?: string; fields?: Record<string, string[]> },
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ status, title: body.code, ...body }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });
}

export function stub(responder: Responder): Stub {
  const calls: Request[] = [];
  const client = createClient({
    baseUrl: BASE_URL,
    token: 'test-token',
    fetch: async (input) => {
      const request = input as Request;
      calls.push(request.clone());
      return responder(request);
    },
  });
  return { client, calls, last: () => calls[calls.length - 1]! };
}

/** A context that never really waits, with a clock the test drives. */
export function fakeContext(startMs = 0): ToolContext & { advance: (ms: number) => void } {
  let now = startMs;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

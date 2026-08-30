/**
 * A refusal has to say the same thing whichever door it comes back through.
 *
 * D89 spells out what an agent gets when the API says no: the machine `code`
 * so it can branch, the `detail` a person reads, and — for D80's metered
 * `POST /submissions` — `retryAfterSeconds`, because "refused" with no wait
 * tells something driving the API in a loop nothing about how to stop being
 * refused. `buildServer` does exactly that for the nineteen TOOLS.
 *
 * The four resources and the two prompts went out the other way: their
 * handlers let an `ApiFailure` propagate, and the SDK turns any thrown error
 * into a bare JSON-RPC `-32603 Internal error` carrying only `err.message` —
 * the detail sentence, with the code, the status and the wait all dropped. So
 * a token minted without `problems:read` reading `duckoj://tags` was told
 * `Internal error: no`, which reads as a transient server fault worth
 * retrying, when the fix is to mint a wider token and no retry will ever
 * work.
 */
import { describe, expect, it } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { fakeContext, problem as problemResponse, stub } from './harness.js';

async function connect(responder: () => Response) {
  const stubbed = stub(responder);
  const server = buildServer(stubbed.client, { writes: true, context: fakeContext() });
  const client = new McpClient({ name: 'test', version: '0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function refusalOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to be refused');
}

describe('a refused resource read', () => {
  it('carries the machine code, not just the sentence', async () => {
    const { client, server } = await connect(() =>
      problemResponse(403, { code: 'insufficient_scope', detail: 'the token lacks problems:read' }),
    );
    const message = await refusalOf(() => client.readResource({ uri: 'duckoj://tags' }));
    expect(message).toContain('insufficient_scope');
    expect(message).toContain('the token lacks problems:read');
    expect(message).toContain('403');
    await server.close();
  });

  it('carries the D80 wait when the API sends one', async () => {
    const { client, server } = await connect(() =>
      problemResponse(429, { code: 'rate_limited', detail: 'slow down' }, { 'Retry-After': '17' }),
    );
    const message = await refusalOf(() =>
      client.readResource({ uri: 'duckoj://contests/x/scoreboard' }),
    );
    expect(message).toContain('rate_limited');
    expect(message).toContain('17');
    await server.close();
  });

  it('a templated resource for something that is not there says so as a bad argument', async () => {
    const { client, server } = await connect(() =>
      problemResponse(404, { code: 'problem_not_found', detail: 'no such problem' }),
    );
    const message = await refusalOf(() =>
      client.readResource({ uri: 'duckoj://problems/ghost/statement' }),
    );
    expect(message).toContain('problem_not_found');
    // -32602 Invalid params, not -32603 Internal error: nothing went wrong on
    // this server, the argument names something that is not there.
    expect(message).toContain('-32602');
    await server.close();
  });
});

/**
 * D102. Every request this server makes carries an access token, and a
 * flagged account's token is refused with `409 password_change_required` —
 * the one refusal whose remedy is not reachable from here at all. An agent
 * that reads `409` and nothing else retries; an agent that reads the code and
 * the sentence stops and tells the person to open a browser. Pinned in all
 * three doors, because the three go through different translations.
 */
describe('D102 — the password-change refusal reaches the agent whole', () => {
  const body = {
    code: 'password_change_required',
    detail: 'This account still holds the password it was issued. Change your password in the web interface first.',
  };

  it('through a tool call', async () => {
    const { client, server } = await connect(() => problemResponse(409, body));
    const result = await client.callTool({ name: 'problems_get', arguments: { code: 'p' } });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]!.text).toContain('password_change_required');
    expect(content[0]!.text).toContain('web interface');
    expect(content[0]!.text).toContain('"status":409');
    await server.close();
  });

  it('through a resource read', async () => {
    const { client, server } = await connect(() => problemResponse(409, body));
    const message = await refusalOf(() => client.readResource({ uri: 'duckoj://tags' }));
    expect(message).toContain('password_change_required');
    expect(message).toContain('web interface');
    await server.close();
  });

  it('through a prompt', async () => {
    const { client, server } = await connect(() => problemResponse(409, body));
    const message = await refusalOf(() =>
      client.getPrompt({ name: 'solve-problem', arguments: { code: 'p' } }),
    );
    expect(message).toContain('password_change_required');
    expect(message).toContain('web interface');
    await server.close();
  });
});

describe('a refused prompt', () => {
  it('carries the machine code too', async () => {
    const { client, server } = await connect(() =>
      problemResponse(404, { code: 'problem_not_found', detail: 'no such problem' }),
    );
    const message = await refusalOf(() =>
      client.getPrompt({ name: 'solve-problem', arguments: { code: 'ghost' } }),
    );
    expect(message).toContain('problem_not_found');
    expect(message).toContain('no such problem');
    await server.close();
  });
});

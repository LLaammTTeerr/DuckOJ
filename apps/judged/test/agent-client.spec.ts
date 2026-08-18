import { describe, expect, it, vi } from 'vitest';
import { HttpAgentClient } from '../src/drivers/dmoj/agent-client.js';

describe('HttpAgentClient', () => {
  it('POSTs the hash to /packages/ensure and resolves on 204', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new HttpAgentClient({
      agentOrigin: 'http://judge-agent.invalid',
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    await client.ensure('a'.repeat(64));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://judge-agent.invalid/packages/ensure');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ hash: 'a'.repeat(64) });
  });

  it('rejects when the agent answers with a non-204 status', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 502 }));
    const client = new HttpAgentClient({
      agentOrigin: 'http://judge-agent.invalid',
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    await expect(client.ensure('b'.repeat(64))).rejects.toThrow(/502/);
  });

  it('rejects when the agent does not respond within the timeout', async () => {
    // fetchImpl never settles on its own — only the AbortSignal firing (real
    // timers, not `vi.useFakeTimers`, which cannot mock `AbortSignal.timeout`)
    // ends the call, proving a hung agent cannot wedge the caller forever.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const client = new HttpAgentClient({
      agentOrigin: 'http://judge-agent.invalid',
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    });

    await expect(client.ensure('c'.repeat(64))).rejects.toBeDefined();
  }, 10_000);
});

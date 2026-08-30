/**
 * The writes switch (D89), through a real MCP client.
 *
 * `selectTools` could be asserted directly in two lines, and that would prove
 * the filter works while proving nothing about what a HOST sees — which is
 * the actual claim: a write tool that is off does not appear in `tools/list`,
 * so an agent cannot call something it was never told about. So this drives
 * the real `McpServer` over the SDK's in-memory transport and asks it the
 * question a host asks.
 */
import { describe, expect, it } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, formatResult, selectTools, SERVER_NAME } from '../src/server.js';
import { TOOLS } from '../src/tools.js';
import { TOOL_NAME_PATTERN } from '../src/tool.js';
import { fakeContext, json, stub } from './harness.js';

async function connect(writes: boolean) {
  const stubbed = stub(() => json({ items: [], nextCursor: null }));
  const server = buildServer(stubbed.client, { writes, context: fakeContext() });
  const client = new McpClient({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, stubbed };
}

const WRITE_TOOL_NAMES = TOOLS.filter((tool) => tool.mutates).map((tool) => tool.name);

describe('the writes switch', () => {
  it('withholds every write tool by default', async () => {
    const { client, server } = await connect(false);
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    expect(WRITE_TOOL_NAMES.length).toBeGreaterThan(0);
    for (const name of WRITE_TOOL_NAMES) expect(listed).not.toContain(name);
    expect(listed).toContain('problems_search');
    await server.close();
  });

  it('exposes them when writes are on', async () => {
    const { client, server } = await connect(true);
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of WRITE_TOOL_NAMES) expect(listed).toContain(name);
    await server.close();
  });

  it('refuses to call a withheld tool, and makes no request while refusing', async () => {
    const { client, server, stubbed } = await connect(false);
    const result = await client.callTool({
      name: 'submissions_submit',
      arguments: { problemCode: 'p', languageKey: 'cpp17', source: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not found');
    // The refusal is the registry's, before any handler: the judge never
    // heard about this call at all.
    expect(stubbed.calls).toHaveLength(0);
    await server.close();
  });

  it('says in its instructions which mode it is in', async () => {
    const readOnly = await connect(false);
    expect(readOnly.client.getInstructions()).toContain('READ-ONLY');
    await readOnly.server.close();
    const writable = await connect(true);
    expect(writable.client.getInstructions()).toContain('ENABLED');
    await writable.server.close();
  });
});

describe('the tool table', () => {
  it('names no admin route', () => {
    // Not "withholds": absent. Every /admin route is `@SessionOnly` (D50) and
    // this server authenticates with a bearer token, so an admin tool could
    // only ever return 403 — registering one would advertise a capability
    // that does not exist.
    for (const tool of TOOLS) expect(tool.name).not.toMatch(/admin/);
  });

  it('gives every tool a host-safe name and a real scope', () => {
    const names = new Set<string>();
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(TOOL_NAME_PATTERN);
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(tool.description).toContain(`\`${tool.scope}\``);
    }
  });

  it('marks as `mutates` exactly the tools whose scope is a write scope', () => {
    for (const tool of TOOLS) {
      const isWriteScope = tool.scope.endsWith(':write') || tool.scope.endsWith(':publish');
      expect(tool.mutates).toBe(isWriteScope);
    }
  });

  it('advertises read tools as read-only to the host', async () => {
    const { client, server } = await connect(true);
    for (const listed of (await client.listTools()).tools) {
      const spec = TOOLS.find((tool) => tool.name === listed.name);
      expect(spec).toBeDefined();
      expect(listed.annotations?.readOnlyHint).toBe(!spec!.mutates);
    }
    await server.close();
  });

  it('selectTools(false) is exactly the read half', () => {
    expect(selectTools(false).every((tool) => !tool.mutates)).toBe(true);
    expect(selectTools(true)).toHaveLength(TOOLS.length);
  });
});

describe('tool results', () => {
  it('is one text block: the human line, then compact JSON', () => {
    const block = formatResult('2 problem(s)', { items: [1, 2] });
    expect(block.text).toBe('2 problem(s)\n{"items":[1,2]}');
  });

  it('answers a failure as isError with the mapped code', async () => {
    const stubbed = stub(
      () =>
        new Response(JSON.stringify({ status: 404, title: 'Not Found', code: 'problem_not_found', detail: 'nope' }), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    const server = buildServer(stubbed.client, { writes: false, context: fakeContext() });
    const client = new McpClient({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'problems_get', arguments: { code: 'nope' } });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]!.text).toContain('problem_not_found');
    expect(content[0]!.text).toContain('"status":404');
    await server.close();
  });

  it('identifies itself as duckoj', async () => {
    const { client, server } = await connect(false);
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    await server.close();
  });
});

describe('resources and prompts', () => {
  it('offers both statement and scoreboard templates plus the two vocabularies', async () => {
    const { client, server } = await connect(false);
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toContain('duckoj://problems/{code}/statement');
    expect(templates).toContain('duckoj://contests/{key}/scoreboard');
    const fixed = (await client.listResources()).resources.map((r) => r.uri);
    expect(fixed).toContain('duckoj://tags');
    expect(fixed).toContain('duckoj://languages');
    await server.close();
  });

  it('offers both prompts', async () => {
    const { client, server } = await connect(false);
    const names = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(names).toEqual(expect.arrayContaining(['solve-problem', 'prepare-problem']));
    await server.close();
  });

  it('packages a statement, its limits and its samples into solve-problem', async () => {
    const stubbed = stub(() =>
      json({
        id: 1,
        code: 'tong-hai-so',
        name: 'Tổng hai số',
        visibility: 'public',
        hasPublishedRevision: true,
        timeMs: 1000,
        memoryKb: 262144,
        testCount: 12,
        me: null,
        tags: [{ slug: 'implementation', nameVi: 'x', nameEn: 'y' }],
        difficulty: 1,
        attemptedCount: 0,
        solvedCount: 0,
        statement: '# T\n\n## Ví dụ\n\n| Dữ liệu vào | Kết quả |\n| --- | --- |\n| `2 3` | `5` |\n',
        sourceAccess: 'solved',
        totalPoints: 100,
        checkerKind: 'wcmp',
        createdAt: '2026-01-01T00:00:00.000Z',
        members: [],
        orgSlugs: [],
        editorial: null,
        editorialAvailable: false,
      }),
    );
    const server = buildServer(stubbed.client, { writes: false, context: fakeContext() });
    const client = new McpClient({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const prompt = await client.getPrompt({ name: 'solve-problem', arguments: { code: 'tong-hai-so' } });
    const text = (prompt.messages[0]!.content as { text: string }).text;
    expect(text).toContain('time limit 1000 ms');
    expect(text).toContain('memory limit 256 MiB');
    expect(text).toContain('### Sample 1');
    expect(text).toContain('2 3');
    // Read-only server: the prompt must not tell the agent to call a tool it
    // cannot see.
    expect(text).toContain('read-only');
    await server.close();
  });
});

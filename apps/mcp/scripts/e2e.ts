/**
 * The end-to-end check: a throwaway account, a real token, the real server on
 * a real stdio pipe, and one real submission graded to `AC`.
 *
 * What the unit tests cannot cover, and this does:
 *
 * - **The transport really carries JSON-RPC.** Every byte of stdout has to be
 *   a frame; a single stray `console.log` anywhere in the server desyncs the
 *   client's parser, and no mocked test can see that. This spawns the process
 *   exactly the way a host does.
 * - **The documented launch command is the one that works.** The docs tell
 *   people to run `corepack pnpm --silent --filter @duckoj/mcp start`, and
 *   pnpm's script banner goes to STDOUT — so the `--silent` in that line is
 *   load-bearing, and step 6 proves it rather than trusting it.
 * - **A real token with real scopes reaches the real routes**, through the
 *   `Origin` header D82 requires of the cookie-authenticated mint.
 *
 * Run: `corepack pnpm --filter @duckoj/mcp e2e` (add `DUCKOJ_E2E_URL=` to
 * point somewhere other than `http://localhost:8080`). It creates one
 * `mcp-e2e-*` account and makes ONE submission, which keeps it inside D80's
 * meter however often it is run.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { API_PREFIX } from '@duckoj/api-prefix';

const origin = process.env['DUCKOJ_E2E_URL'] ?? 'http://localhost:8080';
const api = `${origin}/${API_PREFIX}`;
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverEntry = fileURLToPath(new URL('../dist/main.js', import.meta.url));

const suffix = randomBytes(4).toString('hex');
const username = `mcp-e2e-${suffix}`;
const password = `mcp-e2e-${randomBytes(12).toString('hex')}`;

function step(message: string): void {
  console.log(`\n== ${message}`);
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${api}${path}`, {
    method: 'POST',
    // D82: a cookie-authenticated state change must name an allowed origin.
    // `Origin` is not optional here even though this is not a browser — the
    // guard checks for the COOKIE, not for a browser.
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * `callTool`'s return type is a union that still carries the SDK's legacy
 * `{ toolResult }` variant, so `result.content` is not statically there. The
 * cast is at this one boundary rather than at each of the eight call sites.
 */
function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((block) => block.text ?? '').join('\n');
}

function jsonOf(result: unknown): unknown {
  const text = textOf(result);
  const newline = text.indexOf('\n');
  return JSON.parse(newline === -1 ? text : text.slice(newline + 1));
}

async function main(): Promise<void> {
  step(`1. register a throwaway account (${username}) at ${api}`);
  const registered = await postJson('/auth/register', {
    username,
    email: `${username}@example.invalid`,
    password,
    displayName: 'MCP end-to-end',
  });
  if (!registered.ok) throw new Error(`register: ${String(registered.status)} ${await registered.text()}`);
  console.log(`   registered (HTTP ${String(registered.status)})`);

  step('2. sign in for a session cookie');
  const loggedIn = await postJson('/auth/login', { usernameOrEmail: username, password });
  if (!loggedIn.ok) throw new Error(`login: ${String(loggedIn.status)} ${await loggedIn.text()}`);
  const cookie = (loggedIn.headers.getSetCookie?.() ?? [])
    .map((raw) => raw.split(';')[0])
    .join('; ');
  if (cookie === '') throw new Error('login returned no cookie');
  console.log('   session cookie received');

  step('3. mint a scoped access token (POST /auth/tokens is session-only, D50)');
  const scopes = ['problems:read', 'submissions:read', 'submissions:write', 'languages:read'];
  const minted = await postJson('/auth/tokens', { name: 'mcp-e2e', scopes }, { cookie });
  if (!minted.ok) throw new Error(`mint: ${String(minted.status)} ${await minted.text()}`);
  const token = ((await minted.json()) as { token: string }).token;
  console.log(`   minted a token with ${scopes.join(', ')}`);

  step('4. start the MCP server on stdio, writes enabled');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      PATH: process.env['PATH'] ?? '',
      DUCKOJ_URL: origin,
      DUCKOJ_TOKEN: token,
      DUCKOJ_MCP_WRITES: '1',
    },
    stderr: 'pipe',
  });
  const client = new McpClient({ name: 'duckoj-e2e', version: '0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  console.log(`   connected — ${String(tools.length)} tools: ${tools.map((t) => t.name).join(', ')}`);

  step('5. read the judge through the tools');
  const listed = await client.callTool({ name: 'problems_search', arguments: { limit: 5 } });
  console.log(`   problems_search -> ${textOf(listed).split('\n')[0] ?? ''}`);

  const got = await client.callTool({ name: 'problems_get', arguments: { code: 'tong-hai-so' } });
  const problem = jsonOf(got) as { statement: string; samples: { items: unknown[] } };
  console.log(`   problems_get -> ${textOf(got).split('\n')[0] ?? ''}`);
  console.log(
    `   statement ${String(problem.statement.length)} chars, ` +
      `${String(problem.samples.items.length)} samples parsed`,
  );

  const statement = await client.readResource({
    uri: 'duckoj://problems/tong-hai-so/statement',
  });
  const firstLine = String((statement.contents[0] as { text: string }).text).split('\n')[0];
  console.log(`   resource duckoj://problems/tong-hai-so/statement -> ${firstLine ?? ''}`);

  step('6. the documented pnpm launch command speaks clean JSON-RPC');
  const viaPnpm = new StdioClientTransport({
    command: 'corepack',
    args: ['pnpm', '--silent', '--filter', '@duckoj/mcp', 'start'],
    cwd: repoRoot,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      DUCKOJ_URL: origin,
      DUCKOJ_TOKEN: token,
    },
    stderr: 'pipe',
  });
  const pnpmClient = new McpClient({ name: 'duckoj-e2e-pnpm', version: '0' });
  await pnpmClient.connect(viaPnpm);
  const readOnlyTools = (await pnpmClient.listTools()).tools;
  console.log(
    `   corepack pnpm --silent --filter @duckoj/mcp start -> handshake ok, ` +
      `${String(readOnlyTools.length)} tools (read-only: no write tool exposed = ` +
      `${String(!readOnlyTools.some((t) => t.name === 'submissions_submit'))})`,
  );
  await pnpmClient.close();

  step('7. submit the model solution and watch it to a verdict');
  const source = await readFile(`${repoRoot}content/problems/tong-hai-so/solution.cpp`, 'utf8');
  const submitted = await client.callTool({
    name: 'submissions_submit',
    arguments: { problemCode: 'tong-hai-so', languageKey: 'cpp17', source },
  });
  if (submitted.isError === true) throw new Error(`submit failed: ${textOf(submitted)}`);
  const { id } = jsonOf(submitted) as { id: number };
  console.log(`   submissions_submit -> ${textOf(submitted).split('\n')[0] ?? ''}`);

  const watched = await client.callTool({
    name: 'submissions_watch',
    arguments: { id, timeoutSeconds: 120 },
  });
  if (watched.isError === true) throw new Error(`watch failed: ${textOf(watched)}`);
  const verdict = jsonOf(watched) as {
    verdict: string | null;
    points: number | null;
    maxPoints: number | null;
    cases: { total: number; byVerdict: Record<string, number> };
    polls: number;
  };
  console.log(`   submissions_watch -> ${textOf(watched).split('\n')[0] ?? ''}`);
  console.log(
    `   cases: ${String(verdict.cases.total)} (${JSON.stringify(verdict.cases.byVerdict)}) ` +
      `after ${String(verdict.polls)} polls`,
  );

  await client.close();

  if (verdict.verdict !== 'AC') {
    throw new Error(`expected AC, got ${String(verdict.verdict)}`);
  }
  console.log('\nPASS — read, submit and watch all round-tripped against the live stack.');
}

await main();

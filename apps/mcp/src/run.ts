/**
 * Starting the server on stdio.
 *
 * Split from `main.ts` because `oj mcp` calls it too: the CLI already knows
 * the base URL and the token (it wrote them), so it imports this and hands
 * them over rather than re-discovering them through the environment. `main.ts`
 * is the argv/exit half, exactly as `apps/oj/src/main.ts` is.
 *
 * **Nothing here may write to stdout.** The stdio transport owns it — every
 * byte on stdout is a JSON-RPC frame — and one stray `console.log` desyncs
 * the client's parser for the life of the process. So the banner goes to
 * stderr, which hosts capture as the server's log.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@duckoj/sdk';
import { buildServer, selectTools } from './server.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface RunOptions {
  baseUrl: string;
  token: string;
  writes: boolean;
  /** Where the banner goes; stderr in production, a buffer in tests. */
  log?: (line: string) => void;
}

/** Builds the server, announces what it is exposing, and serves stdio. */
export async function runMcpServer(options: RunOptions): Promise<McpServer> {
  const log = options.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const client = createClient({ baseUrl: options.baseUrl, token: options.token });
  const server = buildServer(client, { writes: options.writes });

  const tools = selectTools(options.writes);
  const writeCount = tools.filter((tool) => tool.mutates).length;
  log(
    `duckoj-mcp: ${options.baseUrl} — ${String(tools.length)} tools ` +
      (options.writes
        ? `(${String(writeCount)} of them write; DUCKOJ_MCP_WRITES=1)`
        : '(read-only; set DUCKOJ_MCP_WRITES=1 to expose write tools)'),
  );

  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Assembling the server: which tools exist, and what a tool call looks like
 * coming back.
 *
 * The writes switch (D89) is enforced HERE and nowhere else — a write tool
 * that is off is never registered, so it does not appear in `tools/list`, and
 * an agent cannot call something it was never told about. The alternative —
 * registering everything and refusing at call time — advertises a capability
 * the server has decided not to have, and an agent that can see a tool will
 * spend a turn trying it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { asApiFailure } from './errors.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { TOOLS } from './tools.js';
import type { Client, ToolContext, ToolSpec } from './tool.js';

export const SERVER_NAME = 'duckoj';
export const SERVER_VERSION = '0.1.0';

export interface BuildOptions {
  writes: boolean;
  /** Overridable so tests do not really wait two seconds a poll. */
  context?: ToolContext;
}

const realContext: ToolContext = {
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * One text block: the human line, a newline, then the compact JSON.
 *
 * Both, always, in that order and in ONE block. A host renders the first line
 * of a tool result in its transcript and a model reads all of it, so a
 * summary-only result is unusable by the model and a JSON-only result is
 * unreadable by the person watching. `JSON.stringify` with no spacing because
 * every space is a token spent on indentation.
 */
export function formatResult(summary: string, data: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: `${summary}\n${JSON.stringify(data)}` };
}

/** The tools this server will expose, given the switch. */
export function selectTools(writes: boolean): ToolSpec[] {
  return TOOLS.filter((tool) => writes || !tool.mutates);
}

export function buildServer(client: Client, options: BuildOptions): McpServer {
  const ctx = options.context ?? realContext;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'DuckOJ — a competitive-programming judge. Read a problem with `problems_get` (its statement, ' +
        'limits and samples), submit with `submissions_submit` and wait for the verdict with ' +
        '`submissions_watch`. Every tool answers one summary line followed by compact JSON. ' +
        (options.writes
          ? 'Write tools are ENABLED on this server: submitting, asking clarifications and editing ' +
            'problems all act as the token owner.'
          : 'This server is READ-ONLY: no tool here changes anything on the judge.'),
    },
  );

  for (const tool of selectTools(options.writes)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: {
          readOnlyHint: !tool.mutates,
          // Nothing here deletes: the closest is `problems_patch`, which
          // replaces fields it is given and leaves the rest.
          destructiveHint: false,
          // Submitting twice submits twice; patching twice patches once.
          idempotentHint: !tool.mutates,
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        try {
          const outcome = await tool.run(client, args, ctx);
          return { content: [formatResult(outcome.summary, outcome.data)] };
        } catch (err) {
          const failure = asApiFailure(err);
          return {
            content: [formatResult(failure.summary(), failure.toJSON())],
            isError: true,
          };
        }
      },
    );
  }

  registerResources(server, client);
  registerPrompts(server, client, options.writes);
  return server;
}

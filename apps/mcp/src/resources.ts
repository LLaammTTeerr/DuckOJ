/**
 * Resources: the things an agent should be able to REFERENCE rather than
 * fetch.
 *
 * A tool call is an action the model decides to take; a resource is a
 * document a host can attach to a conversation on the user's behalf. The two
 * statement/scoreboard URIs are the brief's, and the two fixed lists are here
 * because the tools that need them name them: `submissions_submit` takes a
 * `languageKey` and `problems_search` takes tag slugs, and an agent with no
 * way to read either vocabulary guesses `cpp17` and `dp` and gets a 422.
 *
 * All four are read-only, so none of them is affected by the writes switch.
 */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guarded, unwrap } from './errors.js';
import type { Client } from './tool.js';

/** The scopes a token needs before the resources are worth exposing. */
export const RESOURCE_SCOPES = ['problems:read', 'contests:read', 'languages:read'] as const;

function jsonContents(uri: string, value: unknown) {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }],
  };
}

export function registerResources(server: McpServer, client: Client): void {
  server.registerResource(
    'problem-statement',
    new ResourceTemplate('duckoj://problems/{code}/statement', { list: undefined }),
    {
      title: 'Problem statement',
      description: 'A problem statement as Markdown, exactly as the judge stores it.',
      mimeType: 'text/markdown',
    },
    guarded(async (uri, variables) => {
      const code = String(variables['code']);
      const problem = unwrap(await client.GET('/problems/{code}', { params: { path: { code } } }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            // The name is prepended because the statement's own H1 is the
            // Vietnamese title and the CODE is what every tool here is keyed
            // by — a reader who attaches this needs both.
            text: `# ${problem.code} — ${problem.name}\n\n${problem.statement}`,
          },
        ],
      };
    }),
  );

  server.registerResource(
    'contest-scoreboard',
    new ResourceTemplate('duckoj://contests/{key}/scoreboard', { list: undefined }),
    {
      title: 'Contest scoreboard',
      description: "A contest's scoreboard as JSON, as its format computes it.",
      mimeType: 'application/json',
    },
    guarded(async (uri, variables) => {
      const key = String(variables['key']);
      const board = unwrap(
        await client.GET('/contests/{key}/scoreboard', { params: { path: { key } } }),
      );
      return jsonContents(uri.href, board);
    }),
  );

  server.registerResource(
    'tags',
    'duckoj://tags',
    {
      title: 'Topic tags',
      description: 'Every topic tag a problem can carry — the vocabulary `problems_search` filters by.',
      mimeType: 'application/json',
    },
    guarded(async (uri) => {
      const tags = unwrap(await client.GET('/tags'));
      return jsonContents(uri.href, tags.items);
    }),
  );

  server.registerResource(
    'languages',
    'duckoj://languages',
    {
      title: 'Languages',
      description: 'Every language key `submissions_submit` accepts, with its display name.',
      mimeType: 'application/json',
    },
    guarded(async (uri) => {
      const languages = unwrap(await client.GET('/languages'));
      return jsonContents(uri.href, languages.items);
    }),
  );
}

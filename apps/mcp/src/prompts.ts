/**
 * Prompts: a problem, packaged so an agent can start work without being told
 * how DuckOJ is shaped.
 *
 * `solve-problem` does the fetching a host would otherwise ask the model to
 * do in three tool calls, and — this is the point of it — states the loop
 * (submit, watch, read the first failing case) so the agent does not invent
 * one. `prepare-problem` is the authoring side.
 *
 * **`prepare-problem` describes the CLI/draft flow, not a package.** The
 * brief allows for a `packages/prepare` pipeline package; there is none on
 * this branch (`ls packages`: no `prepare`), so the prompt names what does
 * exist — `scripts/package-build.ts`, `scripts/polygon-import.ts` and the
 * D87 draft routes this server exposes as `problems_draft_*`. Pointing at a
 * package that is not there would be worse than describing the real flow.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { unwrap } from './errors.js';
import { extractSamples } from './samples.js';
import type { Client } from './tool.js';

function samplesBlock(statement: string): string {
  const samples = extractSamples(statement);
  if (samples.length === 0) {
    return 'No sample table could be parsed out of the statement — read the statement itself for the examples.';
  }
  return samples
    .map(
      (sample, index) =>
        `### Sample ${String(index + 1)}\n\nInput:\n\`\`\`\n${sample.input}\n\`\`\`\n\n` +
        `Expected output:\n\`\`\`\n${sample.output}\n\`\`\`` +
        (sample.note === undefined ? '' : `\n\nNote: ${sample.note}`),
    )
    .join('\n\n');
}

export function registerPrompts(server: McpServer, client: Client, writes: boolean): void {
  server.registerPrompt(
    'solve-problem',
    {
      title: 'Solve a DuckOJ problem',
      description:
        'Packages one problem — statement, limits and samples — with the submit-and-watch loop for ' +
        'an agent that is going to write the solution.',
      argsSchema: {
        code: z.string().min(1).describe('the problem code, e.g. `tong-hai-so`'),
        contestKey: z
          .string()
          .min(1)
          .optional()
          .describe('submit into this contest instead of practice'),
      },
    },
    async ({ code, contestKey }) => {
      const problem = unwrap(await client.GET('/problems/{code}', { params: { path: { code } } }));
      const limits = [
        problem.timeMs === null ? null : `time limit ${String(problem.timeMs)} ms`,
        problem.memoryKb === null
          ? null
          : `memory limit ${String(Math.round(problem.memoryKb / 1024))} MiB`,
        problem.testCount === null ? null : `${String(problem.testCount)} tests`,
        problem.totalPoints === null ? null : `${String(problem.totalPoints)} points`,
        problem.checkerKind === null ? null : `checker: ${problem.checkerKind}`,
      ]
        .filter((line): line is string => line !== null)
        .join(', ');

      const loop = writes
        ? 'When the solution is ready, call `submissions_submit` with the source and a language key ' +
          'from `duckoj://languages`' +
          (contestKey === undefined ? '' : `, passing \`contestKey: "${contestKey}"\``) +
          ', then `submissions_watch` with the id it returns. If the verdict is not `AC`, read ' +
          '`cases.firstFailure` — the group, the case and the checker feedback say which test broke ' +
          'and how — and fix the solution before submitting again. Submissions are metered: one ' +
          'every ten seconds, so do not retry in a loop.'
        : 'This server was started read-only (`DUCKOJ_MCP_WRITES` is not `1`), so `submissions_submit` ' +
          'is not available: write the solution and hand it to the user to submit with ' +
          '`oj submit`, or restart the server with writes enabled.';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Solve DuckOJ problem \`${problem.code}\` — ${problem.name}.\n\n` +
                `**Limits.** ${limits === '' ? 'not published' : limits}\n` +
                `**Tags.** ${problem.tags.map((tag) => tag.slug).join(', ') || 'none'}\n` +
                `**Difficulty.** ${problem.difficulty === null ? 'unrated' : String(problem.difficulty)}/10\n\n` +
                `## Statement\n\n${problem.statement}\n\n` +
                `## Samples\n\n${samplesBlock(problem.statement)}\n\n` +
                `## How to finish\n\n${loop}\n\n` +
                'The program reads standard input and writes standard output. Watch the statement for ' +
                'ranges that overflow 32 bits, and for output the checker compares loosely.',
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'prepare-problem',
    {
      title: 'Prepare a DuckOJ problem package',
      description:
        'The authoring pipeline: what a DuckOJ problem package contains and how to get one onto the ' +
        'judge, either through this server or through the repository scripts.',
      argsSchema: {
        code: z
          .string()
          .min(1)
          .optional()
          .describe('an existing problem code to attach a new revision to'),
      },
    },
    ({ code }) => {
      const target = code === undefined ? 'the problem' : `\`${code}\``;
      const draftFlow = writes
        ? `1. \`problems_draft_create\` on ${target} — it answers a \`draftId\`, an \`expiresAt\` and the\n` +
          '   file and byte caps the draft will enforce.\n' +
          '2. `problems_draft_put_file` once per file. Names are flat (`^[A-Za-z0-9._-]+$`), so a test\n' +
          '   at `tests/01` goes in as `01`. The draft needs a `manifest.json` naming every file it\n' +
          '   references, and a re-PUT of a name replaces it.\n' +
          '3. `problems_draft_build` — it validates the manifest, builds the package and attaches it as\n' +
          '   a revision. Leave `publish` false and let a person publish it; pass `publish: true` only\n' +
          '   when you are certain, because publishing archives whatever was live.\n' +
          '4. `problems_patch` for the statement, tags, difficulty and editorial, which live on the\n' +
          '   problem rather than in the package.'
        : 'This server was started read-only (`DUCKOJ_MCP_WRITES` is not `1`), so the draft tools are\n' +
          'not available. Restart it with `DUCKOJ_MCP_WRITES=1` to author through MCP, or use the\n' +
          'repository scripts below.';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Prepare ${target} for DuckOJ.\n\n` +
                '## What a package is\n\n' +
                'A DuckOJ package is a content-addressed archive with a `manifest.json` (limits, test\n' +
                'groups and their points, the checker) plus the test files and the model solution. The\n' +
                'judge grades against a package REVISION, so publishing a new one is how a problem\n' +
                'changes.\n\n' +
                '## Through this server\n\n' +
                `${draftFlow}\n\n` +
                '## Through the repository\n\n' +
                '- `corepack pnpm package:build` (`scripts/package-build.ts`) builds a package from a\n' +
                '  directory laid out like `content/problems/<code>` — `statement.md`, `solution.cpp`,\n' +
                '  `tests/`, `editorial.md`.\n' +
                '- `corepack pnpm polygon:import` (`scripts/polygon-import.ts`) converts a Polygon export\n' +
                '  into that layout.\n' +
                '- `corepack pnpm seed` seeds a built package into a running instance.\n\n' +
                '## Before publishing\n\n' +
                'Check that the statement names every constraint the tests actually use, that the sample\n' +
                'table under the samples heading has one row per sample (this server parses samples out\n' +
                'of that table), and that the group points sum to the problem total. Submit the model\n' +
                'solution and confirm it is `AC` on every group before publishing.',
            },
          },
        ],
      };
    },
  );
}

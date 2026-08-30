/**
 * The shape every DuckOJ tool has, and the one place a tool's declared scope
 * and its write-ness are written down.
 *
 * A table rather than nineteen `server.registerTool(...)` calls, because two
 * things have to be decided ACROSS all of them and neither can be trusted to
 * a convention: which tools the writes switch withholds (D89), and which
 * token scope each one needs. Both are fields here, so the registration loop
 * enforces the switch once and the unit tests can iterate the table instead
 * of naming tools one at a time — a tool added without a scope does not
 * compile, and a tool added with `mutates: true` is withheld by default
 * without anybody remembering to withhold it.
 */
import { z } from 'zod';
import type { createClient } from '@duckoj/sdk';
// Type-only, so nothing of `@duckoj/contracts` is bundled at runtime — but a
// scope that is not one of the fourteen still fails to compile, which is the
// whole point of naming them here rather than typing `string`.
import type { Scope } from '@duckoj/contracts';

export type Client = ReturnType<typeof createClient>;

/** The seams a tool needs that are not the API: the clock, and waiting. */
export interface ToolContext {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** What a tool hands back: one line for a person, compact JSON for a machine. */
export interface ToolOutcome {
  summary: string;
  data: unknown;
}

export interface ToolSpec {
  /** Underscored, never dotted — see `TOOL_NAME_PATTERN` below. */
  name: string;
  title: string;
  /** Prose for the agent. The scope sentence is appended by `defineTool`. */
  description: string;
  /** The token scope this tool's route requires (`packages/contracts/src/scopes.ts`). */
  scope: Scope;
  /** True for anything that changes server state — withheld unless writes are on. */
  mutates: boolean;
  /** A zod raw shape; the MCP SDK turns it into the advertised JSON Schema. */
  shape: z.ZodRawShape;
  run: (client: Client, args: unknown, ctx: ToolContext) => Promise<ToolOutcome>;
}

/**
 * Tool names are `[a-z0-9_]`, never dotted, even though the feature was
 * specified with dots (`problems.list`).
 *
 * A host does not expose a server's tool name unchanged: Claude Code presents
 * it as `mcp__<server>__<tool>`, and the Anthropic API's own tool-name rule is
 * `^[a-zA-Z0-9_-]{1,128}$` — a dot anywhere in the name makes the composed
 * name invalid, and the failure lands on the host, at request time, naming a
 * tool nobody typed. Underscores read the same and cannot do that. The
 * mapping is exactly one-for-one, dot to underscore, so the brief's
 * `problems.list` is this file's `problems_search` group and nothing was
 * renamed beyond the separator.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Wraps one tool: validates the name, appends the scope sentence to the
 * description, and erases the shape's type at the boundary while keeping it
 * inside the handler.
 *
 * The re-parse is not redundant with the SDK's own validation. It is what
 * makes `run` typed at all: the registration loop holds `ToolSpec`, whose
 * `run` takes `unknown`, and a tool that trusted that `unknown` would be
 * writing `args as { code: string }` nineteen times.
 */
export function defineTool<Shape extends z.ZodRawShape>(spec: {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  mutates: boolean;
  shape: Shape;
  run: (
    client: Client,
    args: z.infer<z.ZodObject<Shape>>,
    ctx: ToolContext,
  ) => Promise<ToolOutcome>;
}): ToolSpec {
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new Error(`tool name "${spec.name}" must match ${String(TOOL_NAME_PATTERN)}`);
  }
  const schema = z.object(spec.shape);
  return {
    name: spec.name,
    title: spec.title,
    description: `${spec.description} Requires the \`${spec.scope}\` token scope.`,
    scope: spec.scope,
    mutates: spec.mutates,
    shape: spec.shape,
    run: (client, args, ctx) => spec.run(client, schema.parse(args ?? {}), ctx),
  };
}

/**
 * Drops `undefined` members so a query string carries only what was asked
 * for.
 *
 * The return type EXCLUDES `undefined` rather than being `Partial<T>`: this
 * repo compiles with `exactOptionalPropertyTypes`, under which `{ q?: string
 * | undefined }` is not assignable to the SDK's `{ q?: string }`. The cast is
 * the honest one — the loop has just removed every `undefined` the type is
 * promising is gone.
 */
export function definedOnly<T extends Record<string, unknown>>(
  source: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

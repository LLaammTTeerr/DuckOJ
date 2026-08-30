/**
 * Where `problems_get`'s samples come from, and what it says about it.
 *
 * `GET /problems/{code}` now carries `samples` read from the published
 * revision's package (the files the judge grades against), so this file is no
 * longer how `problems_get` answers; it is how it answers a DuckOJ deployed
 * before D94, or a problem whose package the API could not read. An MCP
 * client is routinely pointed at an older server than the SDK it was built
 * against, and dropping the scraper outright would turn "your API is a
 * version behind" into "this problem has no samples" — silently, which is the
 * exact failure D94 exists to end.
 *
 * The scraper itself moved to `@duckoj/statement-samples` when the web app
 * needed the same reading of the same convention (to tell a duplicated table
 * from one that says something new). It is deliberately narrow — it knows one
 * table shape and answers with nothing rather than a guess — and the `source`
 * field says which of the three things happened (`api`, `statement-table`,
 * `none`), so a caller that gets none knows to read the statement itself
 * rather than concluding the problem has no samples.
 *
 * One difference from the API's samples matters and is not fixable here: a
 * table cell is trimmed prose, so these strings carry no trailing newline,
 * where `source: 'api'` hands back the sample file byte for byte.
 */

import { extractSamples, type Sample } from '@duckoj/statement-samples';

// Re-exported so nothing else in this app has to know which package the
// statement-table reader ended up in.
export { extractSamples };
export type { Sample };

/**
 * A sample as this server reports it. `truncated` is only ever set by
 * `source: 'api'`: the file was longer than the API inlines, and an agent
 * that fed this to a program would be feeding it half a test.
 */
export interface McpSample extends Sample {
  truncated?: boolean;
}

/** What a `problems_get` response says about where its samples came from. */
export type SampleSource = 'api' | 'statement-table' | 'none';

export interface ResolvedSamples {
  source: SampleSource;
  items: McpSample[];
}

/**
 * The samples for one problem, preferring the API's over the scraper's.
 *
 * `samples` is read with `?? []` rather than as the required field the
 * contract says it is, because an MCP server is routinely pointed at a DuckOJ
 * older than the SDK it was built against — the same reason the web reads
 * `problem.editorial ?? null`. An older server sends no `samples` key at all,
 * and reading it as an array would throw on the one call every agent makes
 * first.
 *
 * An EMPTY array falls through to the scraper too, not just an absent one: a
 * package the API could not read and a problem whose tests are all scored
 * both answer `[]`, and the statement's table is the better answer than
 * nothing in either case.
 */
export function resolveSamples(problem: {
  statement: string;
  samples?: Array<{ input: string; output: string; explanation: string | null; truncated: boolean }>;
}): ResolvedSamples {
  const fromApi = problem.samples ?? [];
  if (fromApi.length > 0) {
    return {
      source: 'api',
      items: fromApi.map((sample) => ({
        input: sample.input,
        output: sample.output,
        ...(sample.explanation === null ? {} : { note: sample.explanation }),
        ...(sample.truncated ? { truncated: true } : {}),
      })),
    };
  }
  const scraped = extractSamples(problem.statement);
  return { source: scraped.length > 0 ? 'statement-table' : 'none', items: scraped };
}


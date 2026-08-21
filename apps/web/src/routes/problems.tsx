import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';
import { verdictToken } from './submit.js';

type SubmissionItem =
  paths['/submissions']['get']['responses'][200]['content']['application/json']['items'][number];

/**
 * `memoryKb` (what the API returns, and what a problem's manifest stores)
 * formatted for a human at the edge, not converted anywhere upstream of
 * this — see this file's history / the task report for why `65536 KB` is a
 * regression from the approved mockup (`docs/design/mockup-v1.html`, screen
 * 1: `64M`), not a stylistic choice.
 *
 * A whole number of MB (the overwhelmingly common case — every seeded
 * problem's limit is a round number of MB) renders bare: `64 MB`. A value
 * that is NOT a whole MB (a manifest could in principle set an odd KB
 * figure; nothing in the schema forbids it) renders to one decimal place —
 * `1.5 MB` — rather than either silently rounding (which would lose
 * information a setter might need) or falling back to the unreadable raw KB
 * this task exists to get rid of.
 */
export function formatMemoryMb(memoryKb: number | null): string {
  if (memoryKb === null) return '—';
  const mb = memoryKb / 1024;
  const rounded = Math.round(mb);
  return Number.isInteger(mb) ? `${rounded} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * The viewer's own best/latest verdict per problem, for the `me` column
 * (mockup-v1.html screen 1; spec §3.3 names it explicitly as needing 2.2,
 * `GET /submissions`).
 *
 * `GET /problems` does not — and per spec cannot be made to, without
 * inventing a route, which is Stream A's job — return this, so it is
 * derived client-side from ONE `GET /submissions?user=<username>&limit=100`
 * call per render of this page (gated on being signed in), never one call
 * per problem row: that would be exactly the N+1 shape the task calls out
 * to avoid, and a slow list is worse than a missing column.
 *
 * "Latest" (not a full history scan): submissions come back newest-first,
 * so the first occurrence of a `problemCode` in this page IS its most
 * recent verdict. The tradeoff this makes deliberately: a problem the
 * viewer submitted to but not within their most recent 100 submissions
 * (across ALL problems) will show no verdict here even though one exists,
 * rather than this page ever issuing a second, third, … request to find
 * it. 100 is `PaginationQuery`'s maximum `limit` (`packages/contracts/src/
 * common.ts`) — the largest single page obtainable at all.
 */
function useMyVerdicts(username: string | undefined): Map<string, SubmissionItem['verdict']> {
  const query = useQuery({
    queryKey: ['problems-me-verdicts', username],
    queryFn: async () => {
      const { data, error } = await api.GET('/submissions', {
        params: { query: { user: username as string, limit: 100 } },
      });
      if (error || !data) throw new Error('Could not load your submissions.');
      return data;
    },
    enabled: username !== undefined,
  });

  const map = new Map<string, SubmissionItem['verdict']>();
  for (const s of query.data?.items ?? []) {
    if (!map.has(s.problemCode)) map.set(s.problemCode, s.verdict);
  }
  return map;
}

/**
 * `/problems`: a search box bound to `q`, a table of code/name/limits/tests/
 * me, and a "load more" button driven by the API's opaque `nextCursor`. Uses
 * `useInfiniteQuery` so "load more" appends a page onto what's already on
 * screen instead of replacing it, while a change to the search box starts a
 * fresh query (a new `queryKey`, not another page of the old one).
 *
 * The mockup's `tests` column (screen 1) IS rendered here now that
 * `ProblemSummaryDto` carries `testCount` (`packages/contracts/src/
 * problems.ts`) — added specifically so this list can show it without a
 * request per row. Null exactly when `timeMs`/`memoryKb` are: a problem
 * whose only revision is a draft has no published limits or test count.
 */
export function ProblemsPage() {
  const [q, setQ] = useState('');
  const me = useQuery(meQueryOptions);
  const myVerdicts = useMyVerdicts(me.data?.username);

  const query = useInfiniteQuery({
    queryKey: ['problems', q],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      // `exactOptionalPropertyTypes` (tsconfig.base.json) forbids assigning
      // `undefined` to an optional property outright — an omitted key and a
      // key explicitly set to `undefined` are distinct types here — so an
      // empty search or an absent cursor must be left out of the object
      // entirely rather than included as `undefined`.
      const queryParams: { q?: string; cursor?: string } = {};
      if (q !== '') queryParams.q = q;
      if (pageParam !== undefined) queryParams.cursor = pageParam;
      const { data, error } = await api.GET('/problems', { params: { query: queryParams } });
      if (error || !data) {
        throw new Error('Could not load problems.');
      }
      return data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const problems = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <h1>Problems</h1>
      <label htmlFor="problem-search">Search</label>
      <input id="problem-search" value={q} onChange={(e) => setQ(e.target.value)} />

      {query.isLoading ? <p>Loading…</p> : null}
      {query.isError ? <p role="alert">Could not load problems.</p> : null}

      {problems.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th className="num">Time</th>
              <th className="num">Mem</th>
              <th className="num">Tests</th>
              <th>Me</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((p) => {
              const verdict = myVerdicts.get(p.code);
              return (
                <tr key={p.id}>
                  <td>
                    {/* This component is unit-tested by rendering it directly
                        (test/problems.spec.tsx), with no `RouterProvider`
                        above it by default — `<Link>` throws outside one — so
                        that test now wraps its render in a minimal router
                        context for `<Link>` to resolve. See that file. */}
                    <Link to="/problems/$code" params={{ code: p.code }}>
                      {p.code}
                    </Link>
                  </td>
                  <td>{p.name}</td>
                  {/* Two right-aligned numeric columns, not one free-text
                      cell — tabular numerals only earn their keep when a
                      magnitude lines up under the one above it, which
                      `1000 ms / 65536 KB` concatenated into prose threw
                      away entirely. */}
                  <td className="num">{p.timeMs !== null ? `${p.timeMs} ms` : '—'}</td>
                  <td className="num">{formatMemoryMb(p.memoryKb)}</td>
                  <td className="num">{p.testCount ?? '—'}</td>
                  <td>
                    <span className={`badge ${verdictToken(verdict ?? null)}`}>{verdict ?? '—'}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : !query.isLoading && !query.isError ? (
        <p>No problems found.</p>
      ) : null}

      {query.hasNextPage ? (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          Load more
        </button>
      ) : null}
    </section>
  );
}

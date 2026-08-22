import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api.js';
import { verdictToken } from './submit.js';
import { meQueryOptions } from '../me.js';

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
 *
 * `me` (spec `2026-08-21-best-verdict-design.md`) is server-computed on
 * `ProblemSummaryDto` — the viewer's best verdict on the problem, `null` for
 * an anonymous caller or one they have never (successfully graded a)
 * submission to. This is deliberately NOT backed by a client-side derivation
 * of any kind, even as a fallback: `GET /submissions?user=` is gone from
 * this file entirely, one request becomes zero, and there is exactly one
 * source of truth for the column. See that spec's §1 for why the prior
 * client-side "latest, within the last 100" version was wrong on both axes.
 */
export function ProblemsPage() {
  const me = useQuery(meQueryOptions);
  const [q, setQ] = useState('');

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
      {me.data && me.data.globalRole !== 'user' ? (
        <p>
          <Link to="/problems/new">New problem</Link>
        </p>
      ) : null}
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
            {problems.map((p) => (
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
                <td>
                  <Link to="/problems/$code" params={{ code: p.code }}>
                    {p.name}
                  </Link>
                </td>
                {/* Two right-aligned numeric columns, not one free-text
                    cell — tabular numerals only earn their keep when a
                    magnitude lines up under the one above it, which
                    `1000 ms / 65536 KB` concatenated into prose threw
                    away entirely. */}
                <td className="num">{p.timeMs !== null ? `${p.timeMs} ms` : '—'}</td>
                <td className="num">{formatMemoryMb(p.memoryKb)}</td>
                <td className="num">{p.testCount ?? '—'}</td>
                <td>
                  {/* No badge at all without a verdict: `pend`'s "." glyph
                      means "still grading" on the submit screen, and a
                      problem never attempted is not pending anything. */}
                  {p.me?.verdict ? (
                    <span className={`badge ${verdictToken(p.me.verdict)}`}>{p.me.verdict}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
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

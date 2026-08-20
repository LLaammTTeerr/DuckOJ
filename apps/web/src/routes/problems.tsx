import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api.js';

/**
 * `/problems`: a search box bound to `q`, a table of code/name/limits, and a
 * "load more" button driven by the API's opaque `nextCursor`. Uses
 * `useInfiniteQuery` so "load more" appends a page onto what's already on
 * screen instead of replacing it, while a change to the search box starts a
 * fresh query (a new `queryKey`, not another page of the old one).
 */
export function ProblemsPage() {
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
              <th>Limits</th>
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
                <td>{p.name}</td>
                <td>
                  {p.timeMs !== null ? `${p.timeMs} ms` : '—'} /{' '}
                  {p.memoryKb !== null ? `${p.memoryKb} KB` : '—'}
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

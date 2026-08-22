import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { verdictToken } from './submit.js';

type Submission = paths['/submissions']['get']['responses'][200]['content']['application/json']['items'][number];
// `NonNullable` twice: once to strip `?`'s implicit `undefined` off the
// query-parameters object itself, once more to strip it off `verdict`'s own
// type (an optional query param, `Verdict | undefined`) down to just the
// nine verdict codes — the filter <select>'s "no filter chosen" state is
// represented locally as `undefined`, so the codes-only type is what
// distinguishes "a code" from "nothing selected" instead of conflating two
// different `undefined`s.
type VerdictCode = NonNullable<NonNullable<paths['/submissions']['get']['parameters']['query']>['verdict']>;

const VERDICTS: VerdictCode[] = ['AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'IR', 'CE', 'IE'];

/**
 * `/submissions`: new this task (spec §3.3, "Submissions list — New,
 * consuming 2.2"). There is no mockup screen for it — `mockup-v1.html`'s nav
 * links to it but stops there — so this follows the same table conventions
 * every other screen in the approved design already established: a `.field`
 * search box (problems.tsx), plain `<select>` for an enum filter
 * (submit.tsx's language select), keyset "load more" pagination
 * (problems.tsx), and the shared `.badge` verdict glyph+colour system via
 * `verdictToken` (submit.tsx) — never a second verdict mapper.
 *
 * Each filter change (problem, user, or verdict) starts a fresh query — a
 * new `queryKey`, not another page of the old one — exactly like
 * `problems.tsx`'s search box.
 */
export function SubmissionsPage({
  initialProblem = '',
  initialUser = '',
  initialContest = '',
}: {
  initialProblem?: string;
  initialUser?: string;
  initialContest?: string;
} = {}) {
  // Deep-linkable: `/submissions?problem=x&user=y` seeds the filters (the
  // problem page and profiles link here), after which they are ordinary
  // local state.
  const [problem, setProblem] = useState(initialProblem);
  const [user, setUser] = useState(initialUser);
  const [contest, setContest] = useState(initialContest);
  const [verdict, setVerdict] = useState<VerdictCode | undefined>(undefined);

  const query = useInfiniteQuery({
    queryKey: ['submissions', problem, user, contest, verdict],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      // Same `exactOptionalPropertyTypes` reasoning as problems.tsx's
      // `queryParams`: an absent filter must be OMITTED from the query
      // object, not present with value `undefined`.
      const queryParams: {
        problem?: string;
        user?: string;
        contest?: string;
        verdict?: VerdictCode;
        cursor?: string;
      } = {};
      if (problem !== '') queryParams.problem = problem;
      if (user !== '') queryParams.user = user;
      if (contest !== '') queryParams.contest = contest;
      if (verdict !== undefined) queryParams.verdict = verdict;
      if (pageParam !== undefined) queryParams.cursor = pageParam;
      const { data, error } = await api.GET('/submissions', { params: { query: queryParams } });
      if (error || !data) {
        throw new Error('Could not load submissions.');
      }
      return data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const submissions = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <h1>Submissions</h1>

      <div className="field">
        <span>#</span>
        <input
          aria-label="Filter by problem code"
          placeholder="problem code"
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
        />
      </div>
      <div className="field">
        <span>@</span>
        <input
          aria-label="Filter by username"
          placeholder="username"
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />
      </div>
      <div className="field">
        <span>%</span>
        <input
          aria-label="Filter by contest key"
          placeholder="contest key"
          value={contest}
          onChange={(e) => setContest(e.target.value)}
        />
      </div>
      <label htmlFor="submissions-verdict">Verdict</label>
      <select
        id="submissions-verdict"
        value={verdict ?? ''}
        onChange={(e) => setVerdict(e.target.value === '' ? undefined : (e.target.value as VerdictCode))}
      >
        <option value="">Any</option>
        {VERDICTS.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>

      {query.isLoading ? <p>Loading…</p> : null}
      {query.isError ? <p role="alert">Could not load submissions.</p> : null}

      {submissions.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th className="num">id</th>
              <th>problem</th>
              <th>user</th>
              <th>language</th>
              <th>verdict</th>
              <th className="num">points</th>
              <th>when</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((s: Submission) => (
              <tr key={s.id}>
                <td className="num">
                  <Link to="/submissions/$id" params={{ id: String(s.id) }}>
                    {s.id}
                  </Link>
                </td>
                <td>
                  <Link to="/problems/$code" params={{ code: s.problemCode }}>
                    {s.problemCode}
                  </Link>
                </td>
                <td>
                  <Link to="/users/$username" params={{ username: s.username }}>
                    {s.username}
                  </Link>
                </td>
                <td>{s.languageKey}</td>
                <td>
                  <span className={`badge ${verdictToken(s.verdict)}`}>{s.verdict ?? '—'}</span>
                </td>
                <td className="num">
                  {typeof s.points === 'number' && typeof s.maxPoints === 'number'
                    ? `${s.points}/${s.maxPoints}`
                    : '—'}
                </td>
                <td>{new Date(s.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !query.isLoading && !query.isError ? (
        <p>No submissions found.</p>
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

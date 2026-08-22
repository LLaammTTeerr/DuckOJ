import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';

type Contest = paths['/contests']['get']['responses'][200]['content']['application/json']['items'][number];
type ContestDetail = paths['/contests/{key}']['get']['responses'][200]['content']['application/json'];
type Scoreboard = paths['/contests/{key}/scoreboard']['get']['responses'][200]['content']['application/json'];

/** `2026-03-01T09:00:00Z` → `2026-03-01 09:00`, in the reader's own zone. */
function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** `running`, `upcoming` or `finished`, from the window alone. */
function phaseOf(contest: { startTime: string; endTime: string }): string {
  const now = Date.now();
  if (now < Date.parse(contest.startTime)) return 'upcoming';
  return now <= Date.parse(contest.endTime) ? 'running' : 'finished';
}

export function ContestsPage() {
  const me = useQuery(meQueryOptions);
  const query = useQuery({
    queryKey: ['contests'],
    queryFn: async () => {
      const { data, error } = await api.GET('/contests', {});
      // `GET /contests` declares no error response, so `error` is typed
      // `never` — there is nothing to read a message off, and a transport
      // failure still lands here.
      if (error) throw new Error('Could not load contests.');
      return data;
    },
  });

  return (
    <section className="panel">
      <h1>Contests</h1>
      {me.data && me.data.globalRole !== 'user' ? (
        <p>
          <Link to="/contests/new">New contest</Link>
        </p>
      ) : null}
      {query.isPending ? <p className="muted">Loading…</p> : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {query.data && query.data.items.length === 0 ? (
        <p className="muted">No contests yet.</p>
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Contest</th>
              <th>Format</th>
              <th>Starts</th>
              <th>Ends</th>
              <th>Phase</th>
            </tr>
          </thead>
          <tbody>
            {query.data.items.map((contest: Contest) => (
              <tr key={contest.key}>
                <td>
                  <Link to="/contests/$key" params={{ key: contest.key }}>
                    {contest.name}
                  </Link>
                </td>
                <td>{contest.format}</td>
                <td>{when(contest.startTime)}</td>
                <td>{when(contest.endTime)}</td>
                <td>{phaseOf(contest)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function ContestPage({ contestKey }: { contestKey: string }) {
  const client = useQueryClient();
  const [joinError, setJoinError] = useState<string | null>(null);

  const contest = useQuery({
    queryKey: ['contest', contestKey],
    queryFn: async (): Promise<ContestDetail> => {
      const { data, error } = await api.GET('/contests/{key}', { params: { path: { key: contestKey } } });
      if (error) throw new Error(error.detail ?? 'No such contest.');
      return data;
    },
  });

  // 404 is the ordinary "you have not joined" answer, so it is a state rather
  // than an error — see the endpoint's own note.
  const participation = useQuery({
    queryKey: ['contest-me', contestKey],
    queryFn: async () => {
      const { data } = await api.GET('/contests/{key}/me', { params: { path: { key: contestKey } } });
      return data ?? null;
    },
  });

  async function join(): Promise<void> {
    const { error } = await api.POST('/contests/{key}/join', {
      params: { path: { key: contestKey } },
    });
    if (error) {
      setJoinError(error.detail ?? 'Could not join.');
      return;
    }
    setJoinError(null);
    await client.invalidateQueries({ queryKey: ['contest-me', contestKey] });
    // Joining widens what problems the viewer may see, so the problem list is
    // stale the moment this succeeds.
    await client.invalidateQueries({ queryKey: ['problems'] });
  }

  if (contest.isPending) return <p className="muted">Loading…</p>;
  if (contest.error) return <p role="alert">{contest.error.message}</p>;
  if (!contest.data) return null;

  const joined = participation.data != null;
  const phase = phaseOf(contest.data);

  return (
    <section className="panel">
      <h1>{contest.data.name}</h1>
      <p className="muted">
        {contest.data.format} · {when(contest.data.startTime)} → {when(contest.data.endTime)} · {phase}
      </p>

      {joined ? (
        <p role="status">
          {participation.data!.virtual === 0 ? 'Competing live.' : `Virtual attempt ${String(participation.data!.virtual)}.`}{' '}
          Your window closes {when(participation.data!.endTime)}.
        </p>
      ) : (
        <p>
          <button type="button" onClick={() => void join()} disabled={phase === 'upcoming'}>
            {phase === 'finished' ? 'Join virtually' : 'Join'}
          </button>
          {phase === 'upcoming' ? <span className="muted"> Not started yet.</span> : null}
        </p>
      )}
      {joinError ? <p role="alert">{joinError}</p> : null}

      <h2>Problems</h2>
      {contest.data.problems.length === 0 ? (
        <p className="muted">No problems.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Problem</th>
              <th className="num">Points</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {contest.data.problems.map((problem) => (
              <tr key={problem.code}>
                <td>{problem.label}</td>
                <td>
                  <Link to="/problems/$code" params={{ code: problem.code }}>
                    {problem.name}
                  </Link>
                </td>
                <td className="num">{problem.points}</td>
                <td>
                  {/* The `contestKey` obligation from 4d: a submission only
                      counts if the key travels with it, and this link is how
                      it does. Submitting from the problem page is practice. */}
                  {joined ? (
                    <Link to="/submit" search={{ problem: problem.code, contest: contestKey }}>
                      Submit
                    </Link>
                  ) : (
                    <span className="muted">Join to submit</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        <Link to="/contests/$key/scoreboard" params={{ key: contestKey }}>
          Scoreboard
        </Link>
      </p>
    </section>
  );
}

type Cell = Scoreboard['ranking'][number]['format_data'][string];

/**
 * One scoreboard cell. `tries` only exists under `icpc`, where the
 * convention is the attempt ledger: `+` a first-try solve, `+2` a solve on
 * the third try, `-3` three tries and no solve. `time` is seconds in every
 * format; minutes is how a wall board reads.
 */
function cell(data: Cell | undefined): string {
  if (!data) return '\u2014';
  const minutes = Math.floor(data.time / 60);
  if (data.tries === undefined) {
    // The three non-icpc formats: points, with the scoring time beside a
    // nonzero score.
    return data.points > 0 ? `${String(data.points)} \u00b7 ${String(minutes)}m` : String(data.points);
  }
  if (data.points > 0) {
    const marker = data.tries === 1 ? '+' : `+${String(data.tries - 1)}`;
    return `${String(data.points)} (${marker}, ${String(minutes)}m)`;
  }
  return data.tries > 0 ? `\u2212${String(data.tries)}` : '\u2014';
}

export function ScoreboardPage({ contestKey }: { contestKey: string }) {
  const query = useQuery({
    queryKey: ['scoreboard', contestKey],
    queryFn: async (): Promise<Scoreboard> => {
      const { data, error } = await api.GET('/contests/{key}/scoreboard', {
        params: { path: { key: contestKey } },
      });
      if (error) throw new Error(error.detail ?? 'Could not load the scoreboard.');
      return data;
    },
  });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return null;

  // snake_case throughout: the scoreboard is served in the goldens' own shape,
  // field for field, and renaming it here would put a translation layer
  // between the contract and the screen.
  const { ranking, problems } = query.data;

  return (
    <section className="panel">
      <h1>Scoreboard</h1>
      <p>
        <Link to="/contests/$key" params={{ key: contestKey }}>
          Back to the contest
        </Link>
      </p>
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Participant</th>
            <th className="num">Score</th>
            <th className="num">Time</th>
            {problems.map((problem) => (
              <th key={problem.code} className="num">
                <Link to="/problems/$code" params={{ code: problem.code }}>
                  {problem.label}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ranking.map((row) => (
            <tr key={`${row.participant}-${String(row.virtual)}`}>
              <td className="num">{row.rank}</td>
              <td>
                <Link to="/users/$username" params={{ username: row.participant }}>
                  {row.participant}
                </Link>
                {row.virtual !== 0 ? <span className="muted"> (virtual)</span> : null}
                {row.is_disqualified ? <span className="muted"> (disqualified)</span> : null}
              </td>
              <td className="num">{row.score}</td>
              <td className="num">{row.cumtime}</td>
              {problems.map((problem) => (
                <td key={problem.code} className="num">
                  {cell(row.format_data[problem.code])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {ranking.length === 0 ? <p className="muted">Nobody has competed yet.</p> : null}
    </section>
  );
}

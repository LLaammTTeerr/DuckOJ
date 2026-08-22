/**
 * The admin panel — the UI over the two session-only admin surfaces.
 *
 * The gate here is cosmetic: rendering nothing for a non-admin is courtesy,
 * not security — both endpoints re-decide authorization server-side on every
 * call, and the nav link's visibility (router.tsx) is the same courtesy.
 *
 * Rating is deliberately frictionful. It is the most consequential
 * retroactive operation in the system (it rewrites every rating that
 * follows), so the button is per-contest, labelled with what it does, and
 * the response's `contestsRated` is shown back — an admin who expected "1"
 * and reads "7" has just learned what replay means before wondering.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';

type Contest = paths['/contests']['get']['responses'][200]['content']['application/json']['items'][number];
type GrantResult =
  paths['/admin/users/{username}']['patch']['responses'][200]['content']['application/json'];

function GrantRole() {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'user' | 'setter' | 'admin'>('setter');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function grant(): Promise<void> {
    const { data, error: err } = await api.PATCH('/admin/users/{username}', {
      params: { path: { username } },
      body: { globalRole: role },
    });
    if (err) {
      setError(err.detail ?? 'Could not grant the role.');
      setResult(null);
      return;
    }
    setError(null);
    const granted: GrantResult = data;
    setResult(`${granted.username} is now ${granted.globalRole}.`);
  }

  return (
    <>
      <h2>Grant a global role</h2>
      <p>
        <label>
          Username{' '}
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>{' '}
        <label>
          Role{' '}
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="user">user</option>
            <option value="setter">setter</option>
            <option value="admin">admin</option>
          </select>
        </label>{' '}
        <button type="button" disabled={username === ''} onClick={() => void grant()}>
          Grant
        </button>
      </p>
      {result ? <p role="status">{result}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

function RateContests() {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const contests = useQuery({
    queryKey: ['contests'],
    queryFn: async () => {
      const { data, error: err } = await api.GET('/contests', {});
      if (err) throw new Error('Could not load contests.');
      return data;
    },
  });

  async function setRated(key: string, rated: boolean): Promise<void> {
    const path = rated ? '/admin/contests/{key}/rate' : '/admin/contests/{key}/unrate';
    const { data, error: err } = await api.POST(path, { params: { path: { key } } });
    if (err) {
      setError(err.detail ?? 'Could not change the contest.');
      setNotice(null);
      return;
    }
    setError(null);
    setNotice(
      `Replayed the whole history: ${String(data.contestsRated)} contest${data.contestsRated === 1 ? '' : 's'} now feed ratings.`,
    );
    await client.invalidateQueries({ queryKey: ['contests'] });
  }

  return (
    <>
      <h2>Rated contests</h2>
      <p className="muted">
        Rating or unrating replays every rating from the beginning — profiles change beyond
        this one contest.
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {contests.data && contests.data.items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Contest</th>
              <th>Rated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {contests.data.items.map((contest: Contest) => (
              <tr key={contest.key}>
                <td>{contest.name}</td>
                <td>{contest.isRated ? 'rated' : '—'}</td>
                <td>
                  <button type="button" onClick={() => void setRated(contest.key, !contest.isRated)}>
                    {contest.isRated ? 'Unrate' : 'Rate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No contests.</p>
      )}
    </>
  );
}

export function AdminPage() {
  const me = useQuery(meQueryOptions);
  if (me.isPending) return <p className="muted">Loading…</p>;
  if (!me.data || me.data.globalRole !== 'admin') {
    return <p role="alert">Admins only.</p>;
  }
  return (
    <section className="panel">
      <h1>Administration</h1>
      <GrantRole />
      <RateContests />
    </section>
  );
}

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
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';
import { globalRoleLabel, useT } from '../i18n/index.js';

type Contest = paths['/contests']['get']['responses'][200]['content']['application/json']['items'][number];
type GrantResult =
  paths['/admin/users/{username}']['patch']['responses'][200]['content']['application/json'];

function GrantRole() {
  const t = useT();
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
      setError(err.detail ?? t('admin.grantError'));
      setResult(null);
      return;
    }
    setError(null);
    const granted: GrantResult = data;
    setResult(
      t('admin.granted', {
        username: granted.username,
        role: globalRoleLabel(t, granted.globalRole),
      }),
    );
  }

  return (
    <>
      <h2>{t('admin.grantHeading')}</h2>
      <p>
        <label>
          {t('common.username')}{' '}
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>{' '}
        <label>
          {t('common.role')}{' '}
          {/* The `value`s are the API's own enum; only the labels are words. */}
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="user">{t('globalRole.user')}</option>
            <option value="setter">{t('globalRole.setter')}</option>
            <option value="admin">{t('globalRole.admin')}</option>
          </select>
        </label>{' '}
        <button type="button" disabled={username === ''} onClick={() => void grant()}>
          {t('admin.grant')}
        </button>
      </p>
      {result ? <p role="status">{result}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

function RateContests() {
  const t = useT();
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const contests = useQuery({
    queryKey: ['contests'],
    queryFn: async () => {
      const { data, error: err } = await api.GET('/contests', {});
      if (err) throw new Error(t('contests.loadError'));
      return data;
    },
  });

  async function setRated(key: string, rated: boolean): Promise<void> {
    const path = rated ? '/admin/contests/{key}/rate' : '/admin/contests/{key}/unrate';
    const { data, error: err } = await api.POST(path, { params: { path: { key } } });
    if (err) {
      setError(err.detail ?? t('admin.rateError'));
      setNotice(null);
      return;
    }
    setError(null);
    // Two keys, not a plural rule: Vietnamese has no plural inflection, and
    // the one English message that needs the distinction is cheaper as a
    // branch than as a category engine (see i18n/index.tsx).
    setNotice(
      data.contestsRated === 1
        ? t('admin.replayedOne')
        : t('admin.replayedMany', { count: data.contestsRated }),
    );
    await client.invalidateQueries({ queryKey: ['contests'] });
  }

  return (
    <>
      <h2>{t('admin.ratedHeading')}</h2>
      <p className="muted">{t('admin.ratedNote')}</p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {contests.data && contests.data.items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('contests.colContest')}</th>
              <th>{t('admin.colRated')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {contests.data.items.map((contest: Contest) => (
              <tr key={contest.key}>
                <td>
                  <Link to="/contests/$key" params={{ key: contest.key }}>
                    {contest.name}
                  </Link>
                </td>
                <td>{contest.isRated ? t('admin.rated') : '—'}</td>
                <td>
                  <button type="button" onClick={() => void setRated(contest.key, !contest.isRated)}>
                    {contest.isRated ? t('admin.unrate') : t('admin.rate')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{t('admin.noContests')}</p>
      )}
    </>
  );
}

export function AdminPage() {
  const t = useT();
  const me = useQuery(meQueryOptions);
  if (me.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (!me.data || me.data.globalRole !== 'admin') {
    return <p role="alert">{t('admin.only')}</p>;
  }
  return (
    <section className="panel">
      <h1>{t('admin.title')}</h1>
      <GrantRole />
      <RateContests />
    </section>
  );
}

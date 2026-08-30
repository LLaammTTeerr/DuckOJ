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
 *
 * Every write here follows the app's one shape (M11):
 * `try { … } catch { setError(t('common.networkError')) } finally
 * { setBusy(false) }`, with `disabled={busy}` on the button. openapi-fetch
 * resolves HTTP errors to `{ error }` but RETHROWS network-level failures, so
 * without the `catch` an API restart mid-request is an unhandled rejection in
 * the console and nothing at all on screen; and without the flag the rating
 * replay is double-clickable.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { meQueryOptions } from '../me.js';
import { formatRelative, formatTimestamp, globalRoleLabel, useLocale, useT, type TFunction } from '../i18n/index.js';
import { verdictToken } from './submit.js';

type Contest = paths['/contests']['get']['responses'][200]['content']['application/json']['items'][number];
type GrantResult =
  paths['/admin/users/{username}']['patch']['responses'][200]['content']['application/json'];
type Dashboard = paths['/admin/dashboard']['get']['responses'][200]['content']['application/json'];

function GrantRole() {
  const t = useT();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'user' | 'setter' | 'admin'>('setter');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function grant(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { data, error: err } = await api.PATCH('/admin/users/{username}', {
        params: { path: { username } },
        body: { globalRole: role },
      });
      if (err) {
        setError(err.detail ?? t('admin.grantError'));
        return;
      }
      const granted: GrantResult = data;
      setResult(
        t('admin.granted', {
          username: granted.username,
          role: globalRoleLabel(t, granted.globalRole),
        }),
      );
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
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
        <button type="button" disabled={busy || username === ''} onClick={() => void grant()}>
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
  const [busy, setBusy] = useState(false);
  const contests = useQuery({
    queryKey: ['contests'],
    queryFn: async () => {
      const result = await api.GET('/contests', {});
      if (result.error) throw apiError(result, t('contests.loadError'));
      return result.data;
    },
  });

  /**
   * One `busy` flag for the whole table rather than one per row: a replay
   * rewrites every rating in the system, so while one is in flight no OTHER
   * contest's button should be pressable either. Per-row state would disable
   * the button that was clicked and leave the six beside it live, which is
   * the same double-replay in slower motion.
   */
  async function setRated(key: string, rated: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const path = rated ? '/admin/contests/{key}/rate' : '/admin/contests/{key}/unrate';
      const { data, error: err } = await api.POST(path, { params: { path: { key } } });
      if (err) {
        setError(err.detail ?? t('admin.rateError'));
        return;
      }
      // Two keys, not a plural rule: Vietnamese has no plural inflection, and
      // the one English message that needs the distinction is cheaper as a
      // branch than as a category engine (see i18n/index.tsx).
      setNotice(
        data.contestsRated === 1
          ? t('admin.replayedOne')
          : t('admin.replayedMany', { count: data.contestsRated }),
      );
      await client.invalidateQueries({ queryKey: ['contests'] });
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
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
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setRated(contest.key, !contest.isRated)}
                  >
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

/**
 * M9 — the lost-authenticator path, from the panel.
 *
 * Behind `window.confirm` for the same reason the rejudge button is: it
 * removes a security control from somebody else's account and there is no
 * undo. The standing note above it carries the real warning — the API cannot
 * tell a student from someone claiming to be one, so the identity check is
 * the admin's job, not the route's.
 */
function ResetTotp() {
  const t = useT();
  const [username, setUsername] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reset(): Promise<void> {
    if (!window.confirm(t('admin.totpConfirm', { username }))) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: err } = await api.DELETE('/admin/users/{username}/totp', {
        params: { path: { username } },
      });
      if (err) {
        setError(err.detail ?? t('admin.totpError'));
        return;
      }
      setNotice(t('admin.totpDone', { username }));
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>{t('admin.totpHeading')}</h2>
      <p className="muted">{t('admin.totpNote')}</p>
      <p>
        <label>
          {t('admin.totpUser')}{' '}
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>{' '}
        <button type="button" disabled={busy || username === ''} onClick={() => void reset()}>
          {t('admin.totpReset')}
        </button>
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}


/**
 * D47 — the operations dashboard.
 *
 * One query, refreshed every 15 seconds, because the panels only mean
 * anything together: a queue backing up reads one way beside a live judge
 * and another beside a silent one. TanStack's default of pausing background
 * refetches for a hidden tab is deliberately NOT overridden — an admin who
 * left this open on a second monitor should not keep a poll running against
 * the API all night.
 *
 * Numbers first, tables after: the six tiles are what an operator glances
 * at, and every table below them is the drill-down for one tile. Every
 * entity is a link (submission, problem, user), per the app's rule.
 */
function agePhrase(t: TFunction, seconds: number): string {
  // Three bands rather than `Intl.RelativeTimeFormat`: that formatter says
  // "1 hour ago", and this is a DURATION, not a past instant. The rounding
  // boundaries are generous on purpose — "90 s" is more useful than
  // "2 min" when you are watching a queue drain.
  if (seconds < 90) return t('admin.ageSeconds', { n: seconds });
  if (seconds < 5400) return t('admin.ageMinutes', { n: Math.round(seconds / 60) });
  return t('admin.ageHours', { n: Math.round(seconds / 3600) });
}

/**
 * One tile. `title` is the tooltip a value needs when it is not a number —
 * an em dash alone says "nothing here", and the reader deserves to be told
 * WHY there is nothing (D47: a null is "judged never said", not "zero").
 */
function Stat({ label, value, title }: { label: string; value: string; title?: string | undefined }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  );
}

function Operations() {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dashboard = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: async (): Promise<Dashboard> => {
      const { data, error: err } = await api.GET('/admin/dashboard', {});
      if (err) throw new Error(t('admin.dashError'));
      return data;
    },
    refetchInterval: 15_000,
  });

  async function reclaim(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: err } = await api.POST('/admin/grading/reclaim', {});
      if (err) {
        setError(err.detail ?? t('admin.reclaimError'));
        return;
      }
      // Three messages, not a plural rule: Vietnamese has no plural
      // inflection, and "nothing to requeue" is a different sentence from
      // "requeued none" — the operator needs to know the button worked.
      setNotice(
        data.reclaimed === 0
          ? t('admin.reclaimNone')
          : data.reclaimed === 1
            ? t('admin.reclaimOne')
            : t('admin.reclaimMany', { count: data.reclaimed }),
      );
      await client.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  const data = dashboard.data;
  return (
    <>
      <h2>{t('admin.dashHeading')}</h2>
      <p className="muted">{t('admin.dashNote')}</p>
      {dashboard.isError ? <p role="alert">{t('admin.dashError')}</p> : null}
      {!data ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <>
          <p className="muted">
            {t('admin.dashUpdated', { time: formatTimestamp(data.generatedAt, locale, timeZone) })}
          </p>

          <div className="stats">
            <Stat label={t('admin.queueQueued')} value={String(data.queue.queued)} />
            <Stat label={t('admin.queueRunning')} value={String(data.queue.running)} />
            <Stat label={t('admin.queueExpired')} value={String(data.queue.expiredLeases)} />
            <Stat label={t('admin.queueFailed')} value={String(data.queue.failed)} />
            <Stat
              label={t('admin.queueOldest')}
              value={
                data.queue.oldestQueuedSeconds === null
                  ? t('common.none')
                  : agePhrase(t, data.queue.oldestQueuedSeconds)
              }
            />
          </div>

          <p className="muted">{t('admin.reclaimNote')}</p>
          <p>
            <button type="button" disabled={busy} onClick={() => void reclaim()}>
              {t('admin.reclaim')}
            </button>
          </p>
          {notice ? <p role="status">{notice}</p> : null}
          {error ? <p role="alert">{error}</p> : null}

          <div className="stats">
            <Stat
              label={t('admin.depDatabase')}
              value={data.dependencies.database === 'up' ? t('admin.depUp') : t('admin.depDown')}
            />
            <Stat
              label={t('admin.depRedis')}
              value={data.dependencies.redis === 'up' ? t('admin.depUp') : t('admin.depDown')}
            />
            <Stat label={t('admin.apiWorkers')} value={String(data.runtime.apiWorkers)} />
            <Stat
              label={t('admin.judgedConcurrency')}
              value={
                data.runtime.judgedConcurrency === null
                  ? '\u2014'
                  : String(data.runtime.judgedConcurrency)
              }
              title={data.runtime.judgedConcurrency === null ? t('admin.notReported') : undefined}
            />
          </div>

          <h3>{t('admin.judgesHeading')}</h3>
          {data.judges.length === 0 ? (
            <p className="muted">{t('admin.noJudges')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('admin.colJudge')}</th>
                  <th>{t('admin.colDriver')}</th>
                  <th>{t('admin.colLastSeen')}</th>
                  <th>{t('admin.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {data.judges.map((judge) => (
                  <tr key={judge.name}>
                    <td>{judge.name}</td>
                    <td>{judge.driver}</td>
                    <td>
                      {/* Its own key, not `common.never` ("chưa dùng" —
                          never USED): a judge that has never handshaken has
                          never CONNECTED, which is a different sentence. */}
                      {judge.lastSeen === null
                        ? t('admin.judgeNever')
                        : formatRelative(judge.lastSeen, locale)}
                    </td>
                    {/* A word, not a colour: this table is read on a phone in
                        a corridor, and `.badge` is the verdict system. */}
                    <td>{judge.online ? t('admin.judgeOnline') : t('admin.judgeOffline')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>{t('admin.workersHeading')}</h3>
          {data.workers.length === 0 ? (
            <p className="muted">{t('admin.noWorkers')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('admin.colWorker')}</th>
                  <th>{t('admin.colNowGrading')}</th>
                  <th className="num">{t('admin.colGradedHour')}</th>
                  <th className="num">{t('admin.colIeHour')}</th>
                </tr>
              </thead>
              <tbody>
                {data.workers.map((worker) => (
                  <tr key={worker.workerId}>
                    <td>{worker.workerId}</td>
                    <td>
                      {worker.currentSubmissionId === null ? (
                        t('common.none')
                      ) : (
                        <Link
                          to="/submissions/$id"
                          params={{ id: String(worker.currentSubmissionId) }}
                        >
                          {`#${String(worker.currentSubmissionId)}`}
                        </Link>
                      )}
                    </td>
                    <td className="num">{worker.gradedLastHour}</td>
                    <td className="num">{worker.internalErrorsLastHour}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>{t('admin.failuresHeading')}</h3>
          <p className="muted">{t('admin.failuresNote')}</p>
          {data.recentFailures.length === 0 ? (
            <p className="muted">{t('admin.noFailures')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('admin.colSubmission')}</th>
                  <th>{t('admin.colProblem')}</th>
                  <th>{t('common.username')}</th>
                  <th>{t('admin.colStatus')}</th>
                  <th>{t('admin.colWhen')}</th>
                </tr>
              </thead>
              <tbody>
                {data.recentFailures.map((failure) => (
                  <tr key={failure.submissionId}>
                    <td>
                      <Link to="/submissions/$id" params={{ id: String(failure.submissionId) }}>
                        {`#${String(failure.submissionId)}`}
                      </Link>
                    </td>
                    <td>
                      <Link to="/problems/$code" params={{ code: failure.problemCode }}>
                        {failure.problemCode}
                      </Link>
                    </td>
                    <td>
                      <Link to="/users/$username" params={{ username: failure.username }}>
                        {failure.username}
                      </Link>
                    </td>
                    <td>
                      <span className={`badge ${verdictToken(failure.verdict)}`}>
                        {failure.verdict ?? failure.state}
                      </span>
                    </td>
                    <td>
                      {formatRelative(failure.judgedAt ?? failure.createdAt, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>{t('admin.refusalsHeading')}</h3>
          {data.refusalsLastHour.length === 0 ? (
            <p className="muted">{t('admin.noRefusals')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('admin.colPurpose')}</th>
                  <th className="num">{t('admin.colCount')}</th>
                </tr>
              </thead>
              <tbody>
                {data.refusalsLastHour.map((row) => (
                  <tr key={row.purpose}>
                    {/* The purpose is a machine key (`password_reset`), not
                        a phrase: translating it would hide what to grep for
                        in the API log. */}
                    <td>{row.purpose}</td>
                    <td className="num">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
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
      <Operations />
      <GrantRole />
      <ResetTotp />
      <RateContests />
    </section>
  );
}

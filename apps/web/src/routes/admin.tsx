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
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { LoadError, SkeletonRows, useLastError } from '../states.js';
import { meQueryOptions } from '../me.js';
import {
  formatRelative,
  formatTimestamp,
  globalRoleLabel,
  useLocale,
  useT,
  type TFunction,
} from '../i18n/index.js';
import { verdictToken } from './submit.js';

type Contest =
  paths['/contests']['get']['responses'][200]['content']['application/json']['items'][number];
type GrantResult =
  paths['/admin/users/{username}']['patch']['responses'][200]['content']['application/json'];
type Dashboard = paths['/admin/dashboard']['get']['responses'][200]['content']['application/json'];

/** A screenful of matches; the box is how an admin narrows further. */
const FIND_LIMIT = 10;

/**
 * The admin user lookup — the screen F-49's sweep recorded as **not existing**
 * (D185).
 *
 * `GET /users?q=` has been fully built server-side since Phase 3 and had zero
 * callers. Until this, the only way an administrator reached an account was to
 * know its exact username and type it into a free-text box: a role grant and a
 * two-factor reset both took a string with no lookup, no confirmation and no
 * way to tell `hs000123` from `hs000132`. On a judge whose accounts are minted
 * by bulk import, that is not a small inconvenience — it is the difference
 * between resetting the right pupil's authenticator and the wrong one's.
 *
 * It is deliberately a lookup that FILLS the box rather than a control that
 * replaces it. An admin who already knows the username still types it; the
 * dangerous operations keep their own confirm step; and the found row shows
 * the display name and the current role beside the account, which is the
 * evidence that makes "yes, that is the person" possible at all.
 *
 * **This one searches the whole judge on purpose**, unlike the team form's
 * picker (which is scoped to a school's roster): a global admin acts across
 * every organization, and this screen is already behind the admin gate.
 *
 * **It is also the only caller `GET /users` has, and D188 was decided on
 * that.** The endpoint used to be `@Public()` and anonymously walkable — a
 * province's whole pupil roster in five requests — and now requires an actor.
 * Nothing here changed for it: this screen is signed in as an admin, and the
 * walk meter D188 added counts only requests carrying a `cursor`, which this
 * lookup never sends. The `findMore` line below is a HINT, deliberately not a
 * "load more" button — an admin who needs a different person types a better
 * name, and a directory nobody can page is the point.
 */
function FindAccount({ onPick }: { onPick: (username: string) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const term = q.trim();
  const found = useQuery({
    queryKey: ['admin-user-search', term],
    enabled: term !== '',
    queryFn: async () => {
      const result = await api.GET('/users', { params: { query: { q: term, limit: FIND_LIMIT } } });
      if (result.error) throw apiError(result, t('admin.findError'));
      return result.data;
    },
  });
  const rows = found.data?.items ?? [];

  return (
    <>
      <div className="field">
        <label htmlFor="admin-user-search">{t('admin.findUser')}</label>
        <input
          id="admin-user-search"
          value={q}
          placeholder={t('admin.findHint')}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {term === '' ? null : found.isPending ? (
        <p className="muted">{t('common.loading')}</p>
      ) : found.isError ? (
        <p role="alert">{t('admin.findError')}</p>
      ) : rows.length === 0 ? (
        <p className="muted">{t('admin.findNone', { q: term })}</p>
      ) : (
        <ul>
          {rows.map((user) => (
            <li key={user.username}>
              <button type="button" onClick={() => onPick(user.username)}>
                {t('admin.findPick', {
                  name: user.displayName,
                  username: user.username,
                  role: globalRoleLabel(t, user.globalRole),
                })}
              </button>
            </li>
          ))}
        </ul>
      )}
      {found.data?.nextCursor ? <p className="muted">{t('admin.findMore')}</p> : null}
    </>
  );
}

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
      <FindAccount onPick={setUsername} />
      <p>
        <label>
          {t('common.username')}{' '}
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>{' '}
        <label>
          {t('common.role')} {/* The `value`s are the API's own enum; only the labels are words. */}
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
  /**
   * **Paged since D180, and this is the one that blocked a WRITE.** It was a
   * plain `useQuery` that read `.items` and dropped `nextCursor`, so the
   * server's page of twenty-five was a ceiling: with 167 contests on the live
   * judge, contest #26 onwards had no Rate button on any screen an
   * administrator could reach. A bigger `limit` cannot rescue it — the
   * schema's maximum is 100 — so it is the cursor or nothing.
   *
   * `asc(id)`, the endpoint's unfiltered order, is KEPT: oldest first is
   * oldest-unrated first, which is the order an admin works this table in —
   * a round is rated once, shortly after it ends, and the ones still waiting
   * are the old ones. D177 flipped the teams list because a teacher tails it;
   * nobody tails this.
   *
   * The key is `['contests', 'admin']` rather than `['contests']`, which the
   * contests LIST page also owns and which now carries a phase filter of its
   * own: two different requests under one key is one cache entry answering
   * two questions. `invalidateQueries({ queryKey: ['contests'] })` still
   * reaches this one — react-query matches key prefixes — so a replay still
   * refreshes both.
   */
  const contests = useInfiniteQuery({
    queryKey: ['contests', 'admin'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: { cursor?: string } = {};
      if (pageParam !== undefined) query.cursor = pageParam;
      const result = await api.GET('/contests', { params: { query } });
      if (result.error) throw apiError(result, t('contests.loadError'));
      return result.data;
    },
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
  });
  const rows: Contest[] | undefined = contests.data
    ? contests.data.pages.flatMap((page) => page?.items ?? [])
    : undefined;

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
      {/* D145. A list that will not load used to fall through to
          `admin.noContests` — "no contests yet" — which tells an
          administrator their judge is empty on the morning the API is down.
          The failure is named, and offers the retry. */}
      {contests.isError ? (
        <LoadError
          error={contests.error}
          what={t('contests.loadError')}
          onRetry={() => void contests.refetch()}
        />
      ) : null}
      {/* D143 — the head is drawn WHILE the rows load, so the table does not
          displace the panels below it when the page lands. */}
      {contests.isPending || (rows && rows.length > 0) ? (
        <div className="table-wrap" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th>{t('contests.colContest')}</th>
                <th>{t('admin.colRated')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contests.isPending ? <SkeletonRows rows={6} columns={3} /> : null}
              {(rows ?? []).map((contest: Contest) => (
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
        </div>
      ) : null}
      {rows && rows.length === 0 && !contests.isError ? (
        <p className="muted">{t('admin.noContests')}</p>
      ) : null}
      {contests.hasNextPage ? (
        <p>
          <button
            type="button"
            onClick={() => void contests.fetchNextPage()}
            disabled={contests.isFetchingNextPage}
          >
            {t('common.loadMore')}
          </button>
        </p>
      ) : null}
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
      <FindAccount onPick={setUsername} />
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
function Stat({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string | undefined;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  );
}

/**
 * F-40 — the mail panel, and the one button in DuckOJ that dials a mail
 * server.
 *
 * Split out of `Operations` rather than inlined because it owns state the
 * rest of the page does not: an address the admin is typing, and the result
 * of an action that can take seconds. Everything it displays comes from the
 * snapshot the parent already fetched, so it adds no request of its own.
 *
 * The unconfigured case is a `role="alert"`, not a grey em dash. Every other
 * "not told" on this page (`judgedConcurrency`, an idle judge) is a fact
 * about a reading; this one is a fact about the deployment — mail is the
 * FIRST line of docs/PROVINCE-READINESS.md, and a province that has not set
 * it cannot reset a single password.
 */
function MailPanel({ mail }: { mail: Dashboard['mail'] }) {
  const t = useT();
  const client = useQueryClient();
  const [address, setAddress] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendTest(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: err } = await api.POST('/admin/mail/test', {
        body: { to: address },
      });
      if (err) {
        setError(err.detail ?? t('admin.mailTestError'));
        return;
      }
      if (data.delivered) {
        setNotice(t('admin.mailTestOk', { address }));
      } else {
        // The transport's own words, carried to the screen unaltered (D156).
        // An operator debugging TLS or a rejected credential needs the
        // server's sentence, and a paraphrase here would throw away the
        // entire value of having opened the connection.
        setError(t('admin.mailTestFailed', { error: data.error ?? '' }));
      }
      // The panel is configuration, which a send cannot change — but the
      // rest of the snapshot has aged by however long the SMTP conversation
      // took, so the page is refreshed rather than left stale beside a new
      // result.
      await client.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>{t('admin.mailHeading')}</h3>
      <p className="muted">{t('admin.mailNote')}</p>
      {mail.configured ? null : <p role="alert">{t('admin.mailWarning')}</p>}
      <div className="stats">
        <Stat
          label={t('admin.mailTransport')}
          value={mail.configured ? t('admin.mailConfigured') : t('admin.mailNotConfigured')}
        />
        {/* An em dash for a host that does not exist, exactly as the runtime
            tiles do for a number nobody reported. */}
        <Stat label={t('admin.mailHost')} value={mail.host ?? '\u2014'} />
        <Stat label={t('admin.mailPort')} value={mail.port === null ? '\u2014' : String(mail.port)} />
        <Stat
          label={t('admin.mailSecure')}
          value={mail.secure ? t('admin.mailSecureImplicit') : t('admin.mailSecureStartTls')}
        />
        <Stat
          label={t('admin.mailAuth')}
          value={mail.authenticated ? t('admin.mailAuthYes') : t('admin.mailAuthNo')}
        />
        <Stat label={t('admin.mailFrom')} value={mail.from} />
      </div>

      <h3>{t('admin.mailTestHeading')}</h3>
      <p className="muted">{t('admin.mailTestNote')}</p>
      <p>
        <label>
          {t('admin.mailTestLabel')}{' '}
          <input
            type="email"
            value={address}
            disabled={!mail.configured}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>{' '}
        {/* Disabled on an unconfigured deployment: there is nothing to test,
            the server answers 503, and offering the button would be the same
            "press this and believe it worked" the whole slot exists to end.
            The warning above says why. */}
        <button
          type="button"
          disabled={busy || !mail.configured || address === ''}
          onClick={() => void sendTest()}
        >
          {busy ? t('admin.mailTestSending') : t('admin.mailTestSend')}
        </button>
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
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
  // Polls every 15 s, so the same hole: see `useLastError`.
  const failure = useLastError(dashboard.error, data !== undefined);
  return (
    <>
      <h2>{t('admin.dashHeading')}</h2>
      <p className="muted">{t('admin.dashNote')}</p>
      {failure ? (
        <LoadError
          error={failure}
          what={t('admin.dashError')}
          onRetry={() => void dashboard.refetch()}
        />
      ) : null}
      {!data && failure ? null : !data ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <>
          <p className="muted">
            {t('admin.dashUpdated', { time: formatTimestamp(data.generatedAt, locale, timeZone) })}
          </p>

          <h3>{t('admin.queueHeading')}</h3>
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

          <h3>{t('admin.runtimeHeading')}</h3>
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
            {/* D197 and D200, on screen rather than only in the JSON.
                Both are switches whose whole point is that an operator who
                set NOTHING is on the protective rung, and F-40's lesson is
                that "I set it and I believe it took" is not good enough:
                until this panel showed them, reading which rung a container
                is actually on meant a curl against `/admin/dashboard`. The
                value is the rung's own identifier, untranslated on purpose —
                it is the string an operator types into `.env` (D18's rule for
                API enum values). */}
            <Stat
              label={t('admin.nameDisclosure')}
              value={data.runtime.nameDisclosure}
              title={t('admin.nameDisclosureHint')}
            />
            <Stat
              label={t('admin.registration')}
              value={data.runtime.registration}
              title={t('admin.registrationHint')}
            />
          </div>

          <MailPanel mail={data.mail} />

          <h3>{t('admin.judgesHeading')}</h3>
          {/* Seven columns do not fit a phone, so the table scrolls sideways —
              and unlike the lists elsewhere in the app it holds no link or
              button, so without a tab stop the columns off the right edge are
              unreachable from a keyboard (WCAG 2.1.1). Same wrapper the
              problem list and the scoreboard use. */}
          {data.judges.length === 0 ? (
            <p className="muted">{t('admin.noJudges')}</p>
          ) : (
            <div
              className="grid-scroll"
              tabIndex={0}
              role="region"
              aria-label={t('admin.judgesHeading')}
            >
              <table>
                <thead>
                  <tr>
                    <th>{t('admin.colJudge')}</th>
                    <th>{t('admin.colDriver')}</th>
                    <th>{t('admin.colLastSeen')}</th>
                    <th>{t('admin.colStatus')}</th>
                    {/* Counts, not links: a machine grading two things has no
                      one submission to point at, and the drill-down from a
                      judge is the worker table below. Its own column header
                      (`colJudgeGrading`) rather than the worker table's
                      `colNowGrading`, which labels a submission link. */}
                    <th className="num">{t('admin.colJudgeGrading')}</th>
                    <th className="num">{t('admin.colGradedHour')}</th>
                    {/* F-39. The question this column answers is the one that
                      cost two weeks: a judge can be online, healthy and
                      idle, and still be unable to run the language a queue
                      full of submissions is waiting on. The executors are
                      the judge's OWN names, as it announced them. */}
                    <th>{t('admin.colExecutors')}</th>
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
                      {/* Zero, never a blank: a judge that is up and taking
                        none of the work is exactly what these two columns
                        exist to show, and an empty cell reads as "no data"
                        rather than "none". */}
                      <td className="num">{judge.gradingNow}</td>
                      <td className="num">{judge.gradedLastHour}</td>
                      {/* Empty is a real answer and gets a word: a judge that
                        predates capability recording, or has not handshaken
                        since, announced nothing — which is not the same as
                        announcing that it can run nothing. */}
                      <td>
                        {judge.executors.length === 0
                          ? t('admin.executorsUnknown')
                          : judge.executors.join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Rendered only when something IS blocked, unlike every other
              panel here. Nothing blocked is the ordinary state, and a
              heading followed by "none" on every fifteen-second poll is a
              heading an operator stops reading — which is the last thing
              this one should be. The reason is the driver's own sentence,
              printed verbatim: it names the language nobody can run. */}
          {data.blockedJobs.length > 0 ? (
            <>
              <h3>{t('admin.blockedHeading')}</h3>
              <p className="muted">{t('admin.blockedNote')}</p>
              <table>
                <thead>
                  <tr>
                    <th>{t('admin.colBlockedReason')}</th>
                    <th className="num">{t('admin.colBlockedCount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.blockedJobs.map((blocked) => (
                    <tr key={blocked.reason}>
                      <td>{blocked.reason}</td>
                      <td className="num">{blocked.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          <h3>{t('admin.workersHeading')}</h3>
          {/* Same as the judge table above: it scrolls on a phone and holds
              nothing focusable, so the wrapper is what makes it reachable. */}
          {data.workers.length === 0 ? (
            <p className="muted">{t('admin.noWorkers')}</p>
          ) : (
            <div
              className="grid-scroll"
              tabIndex={0}
              role="region"
              aria-label={t('admin.workersHeading')}
            >
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
            </div>
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
                    <td>{formatRelative(failure.judgedAt ?? failure.createdAt, locale)}</td>
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

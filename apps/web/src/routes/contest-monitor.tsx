/**
 * `/contests/{key}/monitor` — the organiser's contest-day screen (D95).
 *
 * A route rather than a panel on the contest page, on `SimilarityPairPage`'s
 * reasoning: this is the screen an invigilator leaves open on a second
 * monitor for three hours, and a URL is what you send to the colleague in the
 * other room. It is also the only screen in the app that wants a five-second
 * refresh, and folding that into the contest page would put it on every
 * competitor's tab too.
 *
 * **Two live mechanisms, not one, and they cover different failures.**
 *
 *  - `refetchInterval: 5_000` is the floor. TanStack Query's
 *    `refetchIntervalInBackground` defaults to false, so a hidden tab stops
 *    asking (`poll-visibility.spec.tsx` pins that for the whole app) — an
 *    organiser who switched to their email is not reading this. Five seconds
 *    is also the API's own cache TTL, so this poll never asks for something
 *    the server would not have recomputed anyway.
 *  - The WebSocket is what makes it *feel* live. `{type:'watch-contest'}`
 *    enrols this socket, and every `contest-activity` frame prompts a
 *    refetch, so a verdict lands on screen in about a second instead of up to
 *    five. The frame carries the contest key and nothing else (D23's rule: a
 *    realtime push is a signal, never data), so the refetch goes through the
 *    ordinary authorized read.
 *
 * The socket is an accelerator and never a dependency: if it never opens, is
 * refused, or dies, the page is exactly the five-second poll it always was.
 * That is why a refused watch stops reconnecting rather than retrying — a
 * caller the server said no to will be told no again, and hammering an
 * upgrade in a loop for three hours is the one way this page could hurt the
 * deployment it exists to watch.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { formatTimestamp, useLocale, useT, type TFunction } from '../i18n/index.js';
import { LoadError, StaleNotice, useLastError } from '../states.js';
import { verdictToken } from './submit.js';

type Monitor =
  paths['/contests/{key}/monitor']['get']['responses'][200]['content']['application/json'];

/** The backoff ladder `useSubmissionSocket` uses, for its reasons. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000];

/**
 * Opens `/ws`, watches one contest, and calls `onActivity` whenever the
 * gateway says something moved in it.
 *
 * Cloned from `useSubmissionSocket` rather than generalised with it: that
 * hook's whole contract is "one submission id, stop reconnecting once the
 * grade is terminal", and this one's is "one contest key, stop reconnecting
 * once the server has refused". Merging them would mean a hook with two
 * modes and two stop conditions, which is how the terminal check would
 * eventually fire on the wrong one.
 */
export function useContestActivity(
  contestKey: string,
  onActivity: () => void,
  onRefused?: (code: string) => void,
): void {
  useEffect(() => {
    // `disposed` plus the timer handle is what makes this cleanup safe to run
    // against a socket that is still CONNECTING — closing one fires this same
    // run's `close` handler, which would otherwise schedule a reconnect after
    // the effect was torn down. React's StrictMode double-mount hits exactly
    // that path on every dev render.
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function connect(): void {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      // Same origin, and never a credential in the URL: the gateway reads the
      // session cookie, which the browser sends on the upgrade by itself.
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      socket = ws;

      ws.addEventListener('open', () => {
        if (disposed) return;
        ws.send(JSON.stringify({ type: 'watch-contest', key: contestKey }));
      });

      ws.addEventListener('message', (event) => {
        if (disposed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) return;
        const frame = parsed as { type?: unknown; key?: unknown; code?: unknown };
        if (frame.type === 'contest-activity' && frame.key === contestKey) {
          onActivity();
          return;
        }
        if (frame.type === 'contest-watched' && frame.key === contestKey) {
          // The one frame that proves this connection did what it was opened
          // to do, so it — not `open` — is what re-arms the fast rung of the
          // backoff. An API that accepts an upgrade and drops it at once
          // (a restart, a proxy draining) must not become a once-a-second
          // hammer from every organiser's tab.
          attempt = 0;
          onActivity();
          return;
        }
        if (frame.type === 'error') {
          // Refused, and it will be refused again. Stop: the page falls back
          // to its five-second poll, which is what a non-organiser's read
          // would 403 on anyway, so the screen is honest either way.
          disposed = true;
          onRefused?.(typeof frame.code === 'string' ? frame.code : 'watch_error');
          ws.close();
        }
      });

      ws.addEventListener('close', () => {
        if (disposed) return;
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [contestKey, onActivity, onRefused]);
}

/** One tile, in the admin dashboard's own shape (D47). */
function Stat({ label, value, title }: { label: string; value: string; title?: string | undefined }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  );
}

/**
 * A duration, in three bands — the admin dashboard's `agePhrase`, restated
 * here rather than exported across screens because it is three lines and the
 * two pages are free to disagree about their bands later.
 */
function agePhrase(t: TFunction, seconds: number): string {
  if (seconds < 90) return t('monitor.ageSeconds', { n: seconds });
  if (seconds < 5400) return t('monitor.ageMinutes', { n: Math.round(seconds / 60) });
  return t('monitor.ageHours', { n: Math.round(seconds / 3600) });
}

/**
 * How the room is faring on one problem: the share of its attempts that were
 * accepted.
 *
 * Attempts rather than people, and deliberately: the response carries no
 * participant total, so "18 of 40 competitors have this" is not a sentence
 * this page can honestly write — and inventing a denominator out of the
 * numbers it does have would be a bar that means something different from
 * what it looks like. The pass rate is what these four columns actually
 * support, and beside `solvers` it says the thing an organiser is looking
 * for: a low bar with a high `submitted` is a problem the room is grinding
 * at.
 *
 * A problem nobody has attempted has no rate at all, and the bar is empty
 * rather than full.
 *
 * Inline `width`, and only `width`: the track and the fill are painted from
 * the design tokens, so this stays out of `app.css` and still moves with the
 * theme.
 */
function AcceptBar({
  accepted,
  submitted,
  label,
}: {
  accepted: number;
  submitted: number;
  label: string;
}) {
  const ratio = submitted === 0 ? 0 : Math.min(1, accepted / submitted);
  return (
    <div
      role="img"
      aria-label={label}
      style={{
        height: '8px',
        borderRadius: 'var(--r-pill)',
        border: '1px solid var(--line)',
        background: 'var(--glass-inset)',
        overflow: 'hidden',
        minWidth: '80px',
      }}
    >
      <div
        style={{
          width: `${String(Math.round(ratio * 100))}%`,
          height: '100%',
          background: 'var(--ac)',
        }}
      />
    </div>
  );
}

export function ContestMonitorPage({ contestKey }: { contestKey: string }) {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const client = useQueryClient();
  const [socketRefused, setSocketRefused] = useState(false);

  const monitor = useQuery({
    queryKey: ['contest-monitor', contestKey],
    queryFn: async (): Promise<Monitor> => {
      const result = await api.GET('/contests/{key}/monitor', {
        params: { path: { key: contestKey } },
      });
      if (result.error) throw apiError(result, t('monitor.loadError'));
      return result.data;
    },
    // Five seconds — the API's own TTL. A hidden tab stops asking, which is
    // TanStack's default and the property `poll-visibility.spec.tsx` guards.
    refetchInterval: 5_000,
  });

  // Stable across renders, so the socket effect does not tear itself down and
  // reconnect on every poll — a dependency array is only as good as the
  // identity of what is in it.
  const refetch = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['contest-monitor', contestKey] });
  }, [client, contestKey]);
  const onRefused = useCallback(() => setSocketRefused(true), []);
  useContestActivity(contestKey, refetch, onRefused);

  const data = monitor.data;
  // See `useLastError`: this query polls, so TanStack clears its own
  // `error` on every new attempt while there is no data to keep.
  const failure = useLastError(monitor.error, data !== undefined);
  return (
    <section className="panel">
      <h1>{t('monitor.title')}</h1>
      <p className="muted">
        <Link to="/contests/$key" params={{ key: contestKey }}>
          {contestKey}
        </Link>{' '}
        · {t('monitor.subtitle')}
      </p>

      {failure ? (
        <LoadError
          error={failure}
          what={t('monitor.loadError')}
          onRetry={() => void monitor.refetch()}
        />
      ) : null}
      {!data && failure ? null : !data ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <>
          <p className="muted">
            {t('monitor.updated', { time: formatTimestamp(data.generatedAt, locale, timeZone) })}
            {socketRefused ? ` · ${t('monitor.pollOnly')}` : ''}
          </p>
          {/* Two different facts, deliberately both said. The line above is
              the NUMBERS' vintage — the API's own five-second cache stamps
              it, so it moves even when nothing on this screen does. This one
              is whether THIS BROWSER is still receiving them: offline,
              TanStack Query pauses the refetch entirely (`networkMode:
              'online'`), the numbers freeze, and before D141 the page went
              on looking exactly as live as it had a second earlier. */}
          <StaleNotice updatedAt={monitor.dataUpdatedAt} intervalMs={5_000} />

          <div className="stats">
            <Stat label={t('monitor.online')} value={String(data.participantsOnline)} />
            <Stat label={t('monitor.queueDepth')} value={String(data.queue.depth)} />
            <Stat
              label={t('monitor.queueOldest')}
              value={
                data.queue.oldestPendingSeconds === null
                  ? t('common.none')
                  : agePhrase(t, data.queue.oldestPendingSeconds)
              }
            />
            <Stat
              label={t('monitor.judges')}
              value={`${String(data.judges.online)}/${String(data.judges.total)}`}
              title={t('monitor.judgesNote')}
            />
            <Stat label={t('monitor.unanswered')} value={String(data.clarifications.unanswered)} />
            <Stat
              label={t('monitor.refusals')}
              value={String(data.submitRefusalsLast10Min)}
              title={t('monitor.refusalsNote')}
            />
          </div>

          <h2>{t('monitor.problemsHeading')}</h2>
          {data.problems.length === 0 ? (
            <p className="muted">{t('monitor.noProblems')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('monitor.colProblem')}</th>
                  <th className="num">{t('monitor.colSubmitted')}</th>
                  <th className="num">{t('monitor.colAccepted')}</th>
                  <th className="num">{t('monitor.colSolvers')}</th>
                  <th className="num">{t('monitor.colPending')}</th>
                  <th>{t('monitor.colProgress')}</th>
                </tr>
              </thead>
              <tbody>
                {data.problems.map((problem) => (
                  <tr key={problem.code}>
                    <td>
                      <Link to="/problems/$code" params={{ code: problem.code }}>
                        {problem.label} · {problem.code}
                      </Link>
                    </td>
                    <td className="num">{problem.submitted}</td>
                    <td className="num">{problem.accepted}</td>
                    <td className="num">{problem.solvers}</td>
                    <td className="num">{problem.pending}</td>
                    <td>
                      <AcceptBar
                        accepted={problem.accepted}
                        submitted={problem.submitted}
                        label={t('monitor.barLabel', {
                          accepted: problem.accepted,
                          submitted: problem.submitted,
                        })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>{t('monitor.feedHeading')}</h2>
          <p className="muted">{t('monitor.feedNote')}</p>
          {data.feed.length === 0 ? (
            <p className="muted">{t('monitor.noFeed')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('monitor.colTime')}</th>
                  <th>{t('common.username')}</th>
                  <th>{t('monitor.colProblem')}</th>
                  <th>{t('monitor.colVerdict')}</th>
                </tr>
              </thead>
              <tbody>
                {data.feed.map((entry) => (
                  <tr key={entry.submissionId}>
                    <td>
                      {/* Every entity is a hyperlink — the time cell is the
                          submission's own address, which is where an
                          organiser goes to see what actually happened. */}
                      <Link to="/submissions/$id" params={{ id: String(entry.submissionId) }}>
                        {formatTimestamp(entry.createdAt, locale, timeZone)}
                      </Link>
                    </td>
                    <td>
                      <Link to="/users/$username" params={{ username: entry.username }}>
                        {entry.username}
                      </Link>
                      {/* The team the row scores for, when there is one
                          (D105). Not a link to `/users/`: a team name is not
                          an account, which is the 404 B-18 found twice on the
                          similarity screens. */}
                      {entry.team === null ? null : (
                        <>
                          {' '}
                          <span className="muted">{entry.team}</span>
                        </>
                      )}
                    </td>
                    <td>
                      <Link to="/problems/$code" params={{ code: entry.problemCode }}>
                        {entry.problemLabel}
                      </Link>
                    </td>
                    <td>
                      {/* The badge is colour AND a glyph, never colour alone
                          — and `pend` is what "still grading" looks like,
                          which is the same token the submit page uses. */}
                      <span className={`badge ${verdictToken(entry.verdict)}`}>
                        {entry.verdict ?? t('monitor.grading')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>{t('monitor.clarificationsHeading')}</h2>
          {data.clarifications.latest.length === 0 ? (
            <p className="muted">{t('monitor.noClarifications')}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t('monitor.colTime')}</th>
                  <th>{t('common.username')}</th>
                  <th>{t('monitor.colProblem')}</th>
                  <th>{t('monitor.colQuestion')}</th>
                </tr>
              </thead>
              <tbody>
                {data.clarifications.latest.map((row) => (
                  <tr key={row.id}>
                    <td>{formatTimestamp(row.createdAt, locale, timeZone)}</td>
                    <td>
                      <Link to="/users/$username" params={{ username: row.askedBy }}>
                        {row.askedBy}
                      </Link>
                    </td>
                    <td>
                      {row.problemCode === null ? (
                        t('monitor.wholeContest')
                      ) : (
                        <Link to="/problems/$code" params={{ code: row.problemCode }}>
                          {row.problemCode}
                        </Link>
                      )}
                    </td>
                    <td>{row.question}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p>
            {/* Answering happens on the contest page's Q&A panel (D31) —
                there is one place a clarification is written, and this
                screen points at it rather than growing a second form. */}
            <Link to="/contests/$key" params={{ key: contestKey }}>
              {t('monitor.answerThere')}
            </Link>
          </p>
        </>
      )}
    </section>
  );
}

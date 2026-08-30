import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { paths } from '@duckoj/sdk';
import { API_PREFIX } from '@duckoj/api-prefix';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { formatPoints } from '../format.js';
import { meQueryOptions } from '../me.js';
import { formatDateTime, formatTime, useLocale, useT, type Locale, type MsgKey, type TFunction } from '../i18n/index.js';

/**
 * The whole contest as one printable PDF (D48). A plain `<a>`, like the
 * problem page's own PDF link: this is the API's own response, outside the
 * router's tree, and on a server with no typst configured it answers an
 * honest 501. `lang` follows the reader's own locale — the booklet prints
 * one half of a bilingual statement, and the half they are reading the site
 * in is the one they want on paper.
 */
function bookletUrl(contestKey: string, locale: Locale): string {
  return `${import.meta.env.VITE_API_ORIGIN ?? ''}/${API_PREFIX}/contests/${contestKey}/booklet.pdf?lang=${locale}`;
}

type Contest = paths['/contests']['get']['responses'][200]['content']['application/json']['items'][number];
type ContestDetail = paths['/contests/{key}']['get']['responses'][200]['content']['application/json'];
type Scoreboard = paths['/contests/{key}/scoreboard']['get']['responses'][200]['content']['application/json'];
type Clarification =
  paths['/contests/{key}/clarifications']['get']['responses'][200]['content']['application/json']['items'][number];

/**
 * `2026-03-01T09:00:00Z` → `01/03/2026 16:00` (vi) or `3/1/2026 04:00` (en),
 * in the reader's own zone AND the reader's own date order — the day/month
 * order is not cosmetic, and a Vietnamese page printing `3/1/2026` for the
 * first of March is a wrong date, not an odd-looking one.
 */
function when(iso: string, locale: Locale): string {
  return formatDateTime(iso, locale);
}

/**
 * `running`, `upcoming` or `finished`, from the window alone.
 *
 * Stays an untranslated TOKEN: three call sites branch on it (`phase ===
 * 'upcoming'` disables the join button, `'finished'` relabels it), and a
 * localized string here would make that logic depend on the UI language.
 * `phaseLabel` below is where it becomes words.
 */
type Phase = 'upcoming' | 'running' | 'finished';
function phaseOf(contest: { startTime: string; endTime: string }): Phase {
  const now = Date.now();
  if (now < Date.parse(contest.startTime)) return 'upcoming';
  return now <= Date.parse(contest.endTime) ? 'running' : 'finished';
}

const PHASE_KEYS: Record<Phase, MsgKey> = {
  upcoming: 'phase.upcoming',
  running: 'phase.running',
  finished: 'phase.finished',
};
function phaseLabel(t: TFunction, phase: Phase): string {
  return t(PHASE_KEYS[phase]);
}

export function ContestsPage() {
  const t = useT();
  const { locale } = useLocale();
  const me = useQuery(meQueryOptions);
  const query = useQuery({
    queryKey: ['contests'],
    queryFn: async () => {
      const result = await api.GET('/contests', {});
      // `GET /contests` declares no error response, so `error` is typed
      // `never` — there is nothing to read a message off, and a transport
      // failure still lands here.
      if (result.error) throw apiError(result, t('contests.loadError'));
      return result.data;
    },
  });

  return (
    <section className="panel">
      <h1>{t('contests.title')}</h1>
      {me.data && me.data.globalRole !== 'user' ? (
        <p>
          <Link to="/contests/new">{t('contests.new')}</Link>
        </p>
      ) : null}
      {query.isPending ? <p className="muted">{t('common.loading')}</p> : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {query.data && query.data.items.length === 0 ? (
        <p className="muted">{t('contests.empty')}</p>
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('contests.colContest')}</th>
              <th>{t('contests.colFormat')}</th>
              <th>{t('contests.colStarts')}</th>
              <th>{t('contests.colEnds')}</th>
              <th>{t('contests.colPhase')}</th>
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
                {/* `format` is the registry's own key (`icpc`, `ioi16`) —
                    an identifier every setter types into the create form,
                    not a word to translate. */}
                <td>{contest.format}</td>
                <td>{when(contest.startTime, locale)}</td>
                <td>{when(contest.endTime, locale)}</td>
                <td>{phaseLabel(t, phaseOf(contest))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function ContestPage({ contestKey }: { contestKey: string }) {
  const t = useT();
  const { locale } = useLocale();
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const [joinError, setJoinError] = useState<string | null>(null);
  // Joining a FINISHED contest mints a new virtual attempt server-side on
  // every call (max(virtual)+1, by design) — so the button must not be able
  // to fire twice before the refetch lands.
  const [joinBusy, setJoinBusy] = useState(false);

  const contest = useQuery({
    queryKey: ['contest', contestKey],
    queryFn: async (): Promise<ContestDetail> => {
      const result = await api.GET('/contests/{key}', { params: { path: { key: contestKey } } });
      if (result.error) throw apiError(result, t('contest.notFound'));
      return result.data;
    },
  });

  // 404 is the ordinary "you have not joined" answer, so it is a state rather
  // than an error — see the endpoint's own note.
  //
  // `enabled` because the route is session-only: to a signed-out visitor it
  // answers 401, and a contest page is the most public page this app has.
  // Asking anyway put a red console line under every anonymous visit and
  // taught nothing — a visitor has joined nothing by definition. Same guard
  // the notification bell uses.
  const participation = useQuery({
    queryKey: ['contest-me', contestKey],
    queryFn: async () => {
      const { data } = await api.GET('/contests/{key}/me', { params: { path: { key: contestKey } } });
      return data ?? null;
    },
    enabled: me.data != null,
  });

  async function join(): Promise<void> {
    setJoinBusy(true);
    try {
      const { error } = await api.POST('/contests/{key}/join', {
        params: { path: { key: contestKey } },
      });
      if (error) {
        setJoinError(error.detail ?? t('contest.joinError'));
        return;
      }
      setJoinError(null);
      await client.invalidateQueries({ queryKey: ['contest-me', contestKey] });
      // Joining widens what problems the viewer may see, so the problem list is
      // stale the moment this succeeds.
      await client.invalidateQueries({ queryKey: ['problems'] });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setJoinError(t('common.networkError'));
    } finally {
      setJoinBusy(false);
    }
  }

  if (contest.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (contest.error) return <p role="alert">{contest.error.message}</p>;
  if (!contest.data) return null;

  const joined = participation.data != null;
  const phase = phaseOf(contest.data);

  return (
    <section className="panel">
      <h1>{contest.data.name}</h1>
      <p className="muted">
        {contest.data.format} · {when(contest.data.startTime, locale)} →{' '}
        {when(contest.data.endTime, locale)} · {phaseLabel(t, phase)}
      </p>
      {/* `canEdit` is the server's own answer, not a guess from `me` — see
          the field's note in the contract. */}
      {contest.data.canEdit ? (
        <p>
          <Link to="/contests/$key/edit" params={{ key: contestKey }}>
            {t('contest.edit')}
          </Link>
        </p>
      ) : null}

      {joined ? (
        <p role="status">
          {participation.data!.virtual === 0
            ? t('contest.live')
            : t('contest.virtual', { n: participation.data!.virtual })}{' '}
          {t('contest.windowCloses', { when: when(participation.data!.endTime, locale) })}
        </p>
      ) : (
        <p>
          <button type="button" onClick={() => void join()} disabled={joinBusy || phase === 'upcoming'}>
            {phase === 'finished' ? t('contest.joinVirtually') : t('contest.join')}
          </button>
          {phase === 'upcoming' ? <span className="muted"> {t('contest.notStarted')}</span> : null}
        </p>
      )}
      {joinError ? <p role="alert">{joinError}</p> : null}

      <h2>{t('contest.problems')}</h2>
      {contest.data.problems.length === 0 ? (
        <p className="muted">{t('contest.noProblems')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('contest.colLabel')}</th>
              <th>{t('contest.colProblem')}</th>
              <th className="num">{t('contest.colPoints')}</th>
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
                {/* The one place the contest's OWN `pointsPrecision` is
                    available to format with — it rides on `GET
                    /contests/{key}` and on no other payload this app reads
                    (the scoreboard's does not carry it), so every other
                    score display falls back to formatPoints' default. */}
                <td className="num">{formatPoints(problem.points, contest.data.pointsPrecision)}</td>
                <td>
                  {/* The `contestKey` obligation from 4d: a submission only
                      counts if the key travels with it, and this link is how
                      it does. Submitting from the problem page is practice. */}
                  {joined ? (
                    <Link to="/submit" search={{ problem: problem.code, contest: contestKey }}>
                      {t('contest.submit')}
                    </Link>
                  ) : (
                    <span className="muted">{t('contest.joinToSubmit')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ClarificationsPanel
        contestKey={contestKey}
        phase={phase}
        joined={joined}
        canEdit={contest.data.canEdit}
        problems={contest.data.problems.map((problem) => ({ code: problem.code, label: problem.label }))}
      />

      <p>
        <Link to="/contests/$key/scoreboard" params={{ key: contestKey }}>
          {t('contest.scoreboard')}
        </Link>{' '}
        {/* Only once there is a problem list to print. Before the start the
            API conceals it from everyone but the people who run the contest
            and answers 404 here — offering the link anyway would be a
            download that fails for exactly the visitors it is aimed at. */}
        {contest.data.problems.length > 0 ? (
          <>
            <a href={bookletUrl(contestKey, locale)}>{t('contest.booklet')}</a>{' '}
          </>
        ) : null}
        {/* Submissions made INTO this contest (`?contest=`), not practice
            submissions to its problems — the same distinction the submit
            links above are explicit about. */}
        <Link to="/submissions" search={{ contest: contestKey }}>
          {t('common.allSubmissions')}
        </Link>
        {me.data ? (
          <>
            {' '}
            <Link to="/submissions" search={{ contest: contestKey, user: me.data.username }}>
              {t('common.mySubmissions')}
            </Link>
          </>
        ) : null}
      </p>
    </section>
  );
}


/**
 * The contest-day Q&A panel (D31): announcements and clarifications, an ask
 * form for a participant, answer/publish controls and an announcement form
 * for an organiser.
 *
 * Polled every 30 s **while the contest is running** and never otherwise —
 * `refetchInterval: false` once it has finished, because a finished
 * contest's Q&A does not change and two thousand browsers asking anyway is
 * the load profile this feature was cheapest to get wrong on. No WebSocket:
 * the realtime channel carries submissions, and widening it for a feed that
 * tolerates half a minute of staleness would be a new failure mode for no
 * benefit a reader can perceive.
 */
function ClarificationsPanel({
  contestKey,
  phase,
  joined,
  canEdit,
  problems,
}: {
  contestKey: string;
  phase: Phase;
  joined: boolean;
  canEdit: boolean;
  problems: { code: string; label: string }[];
}) {
  const t = useT();
  const { locale } = useLocale();
  const client = useQueryClient();
  const [question, setQuestion] = useState('');
  const [askProblem, setAskProblem] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [announceProblem, setAnnounceProblem] = useState('');
  const [announceBusy, setAnnounceBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const feed = useQuery({
    queryKey: ['clarifications', contestKey],
    queryFn: async () => {
      const result = await api.GET('/contests/{key}/clarifications', {
        params: { path: { key: contestKey } },
      });
      if (result.error) throw apiError(result, t('clar.loadError'));
      return result.data;
    },
    refetchInterval: phase === 'running' ? 30_000 : false,
  });

  async function refresh(): Promise<void> {
    await client.invalidateQueries({ queryKey: ['clarifications', contestKey] });
  }

  async function ask(): Promise<void> {
    setAskBusy(true);
    setError(null);
    try {
      const { error: failure } = await api.POST('/contests/{key}/clarifications', {
        params: { path: { key: contestKey } },
        body: { question, problemCode: askProblem === '' ? null : askProblem },
      });
      if (failure) {
        setError(failure.detail ?? t('clar.askError'));
        return;
      }
      setQuestion('');
      await refresh();
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError(t('common.networkError'));
    } finally {
      setAskBusy(false);
    }
  }

  async function announce(): Promise<void> {
    setAnnounceBusy(true);
    setError(null);
    try {
      const { error: failure } = await api.POST('/contests/{key}/announcements', {
        params: { path: { key: contestKey } },
        body: { text: announcement, problemCode: announceProblem === '' ? null : announceProblem },
      });
      if (failure) {
        setError(failure.detail ?? failure.code);
        return;
      }
      setAnnouncement('');
      await refresh();
    } catch {
      setError(t('common.networkError'));
    } finally {
      setAnnounceBusy(false);
    }
  }

  /**
   * One row's PATCH. `answer` and `visibility` travel separately because
   * they are separate decisions: an organiser writes a reply the asker alone
   * should see far more often than they publish one, and a form that always
   * sent both would make publishing the default.
   */
  async function patchRow(id: number, body: { answer?: string; visibility?: 'public' }): Promise<void> {
    setRowBusy(id);
    setError(null);
    try {
      const { error: failure } = await api.PATCH('/contests/{key}/clarifications/{id}', {
        params: { path: { key: contestKey, id: String(id) } },
        body,
      });
      if (failure) {
        setError(failure.detail ?? failure.code);
        return;
      }
      await refresh();
    } catch {
      setError(t('common.networkError'));
    } finally {
      setRowBusy(null);
    }
  }

  function scope(item: Clarification): string {
    if (item.problemCode === null) return t('clar.aboutContest');
    const label = problems.find((problem) => problem.code === item.problemCode)?.label;
    return t('clar.about', { problem: label ?? item.problemCode });
  }

  return (
    <section>
      <h2>{t('clar.title')}</h2>

      {canEdit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void announce();
          }}
        >
          <h3>{t('clar.announceTitle')}</h3>
          <p>
            <label>
              {t('clar.aboutContest')}{' '}
              <select value={announceProblem} onChange={(e) => setAnnounceProblem(e.target.value)}>
                <option value="">{t('clar.anyProblem')}</option>
                {problems.map((problem) => (
                  <option key={problem.code} value={problem.code}>
                    {problem.label}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <textarea
              aria-label={t('clar.announceTitle')}
              placeholder={t('clar.announcePlaceholder')}
              value={announcement}
              onChange={(e) => setAnnouncement(e.target.value)}
              rows={3}
            />
          </p>
          <p>
            <button type="submit" disabled={announceBusy || announcement.trim() === ''}>
              {t('clar.announce')}
            </button>
          </p>
        </form>
      ) : null}

      {joined ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <h3>{t('clar.askTitle')}</h3>
          <p>
            <label>
              {t('clar.aboutContest')}{' '}
              <select value={askProblem} onChange={(e) => setAskProblem(e.target.value)}>
                <option value="">{t('clar.anyProblem')}</option>
                {problems.map((problem) => (
                  <option key={problem.code} value={problem.code}>
                    {problem.label}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <textarea
              aria-label={t('clar.askTitle')}
              placeholder={t('clar.askPlaceholder')}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
            />
          </p>
          <p>
            <button type="submit" disabled={askBusy || question.trim() === ''}>
              {t('clar.ask')}
            </button>
          </p>
        </form>
      ) : (
        <p className="muted">{t('clar.joinToAsk')}</p>
      )}

      {error ? <p role="alert">{error}</p> : null}
      {feed.error ? <p role="alert">{feed.error.message}</p> : null}
      {feed.data && feed.data.items.length === 0 ? (
        <p className="muted">{t('clar.empty')}</p>
      ) : null}

      {feed.data?.items.map((item) => (
        <article key={item.id}>
          <p className="muted">
            {item.question === null ? t('clar.announcement') : t('clar.question')} · {scope(item)} ·{' '}
            {when(item.createdAt, locale)}
            {item.visibility === 'private' ? <> · {t('clar.private')}</> : null}
          </p>
          {item.question === null ? null : <p>{item.question}</p>}
          {item.answer === null ? (
            <p className="muted">{t('clar.unanswered')}</p>
          ) : (
            <p>
              <strong>{item.answer}</strong>
            </p>
          )}
          {canEdit && item.question !== null ? (
            <p>
              <textarea
                aria-label={`${t('clar.answer')} #${String(item.id)}`}
                placeholder={t('clar.answerPlaceholder')}
                value={answers[item.id] ?? item.answer ?? ''}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [item.id]: e.target.value }))}
                rows={2}
              />{' '}
              <button
                type="button"
                disabled={rowBusy === item.id}
                onClick={() => void patchRow(item.id, { answer: answers[item.id] ?? item.answer ?? '' })}
              >
                {t('clar.answer')}
              </button>{' '}
              {item.visibility === 'private' ? (
                <button
                  type="button"
                  disabled={rowBusy === item.id}
                  onClick={() => void patchRow(item.id, { visibility: 'public' })}
                >
                  {t('clar.publish')}
                </button>
              ) : (
                <span className="muted">{t('clar.published')}</span>
              )}
            </p>
          ) : null}
        </article>
      ))}
    </section>
  );
}

/**
 * The freeze instant, as the banner should say it (m17).
 *
 * `frozenAt` is the CONTEST's freeze instant while `frozen` is
 * per-participation (D22), so a virtual entrant replaying a contest three
 * weeks later is told the board froze at a time that is not today. `HH:MM`
 * alone then reads as this afternoon. Same day: the time, which is what
 * somebody sitting the live contest wants. Any other day: the date too.
 */
function freezeInstant(iso: string, locale: Locale): string {
  const at = new Date(iso);
  const today = new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  return sameDay ? formatTime(iso, locale) : formatDateTime(iso, locale);
}

type Cell = Scoreboard['ranking'][number]['format_data'][string];

/**
 * One scoreboard cell. `tries` only exists under `icpc`, where the
 * convention is the attempt ledger: `+` a first-try solve, `+2` a solve on
 * the third try, `-3` three tries and no solve. `time` is seconds in every
 * format; minutes is how a wall board reads.
 *
 * Untranslated, on purpose: `+`, `−` and the `m` minute suffix are the ICPC
 * scoreboard's own notation, read identically at every contest in the world
 * — a Vietnamese `p` for "phút" here would make this board unreadable to
 * anyone who has seen one before, which is everyone it is for.
 */
function cell(data: Cell | undefined, pending = 0): string {
  const marker = pending > 0 ? `?+${String(pending)}` : '';
  // A cell with nothing but hidden attempts is `?+n` ALONE. Prefixing the
  // em-dash would read as "nothing happened here, and also two things did".
  if (!data) return marker === '' ? '\u2014' : marker;
  const suffix = marker === '' ? '' : ` ${marker}`;
  const minutes = Math.floor(data.time / 60);
  if (data.tries === undefined) {
    // The three non-icpc formats: points, with the scoring time beside a
    // nonzero score.
    return data.points > 0
      ? `${formatPoints(data.points)} \u00b7 ${String(minutes)}m${suffix}`
      : `${formatPoints(data.points)}${suffix}`;
  }
  if (data.points > 0) {
    const tries = data.tries === 1 ? '+' : `+${String(data.tries - 1)}`;
    return `${formatPoints(data.points)} (${tries}, ${String(minutes)}m)${suffix}`;
  }
  return data.tries > 0 ? `\u2212${String(data.tries)}${suffix}` : `\u2014${suffix}`;
}

export function ScoreboardPage({ contestKey }: { contestKey: string }) {
  const client = useQueryClient();
  const [dqError, setDqError] = useState<string | null>(null);
  // One busy flag keyed by username, not a single boolean: several rows each
  // have their own link, and disabling the whole board because one row is in
  // flight would be a worse lie than disabling none.
  const [dqBusy, setDqBusy] = useState<string | null>(null);

  const t = useT();
  const { locale } = useLocale();
  const query = useQuery({
    queryKey: ['scoreboard', contestKey],
    queryFn: async (): Promise<Scoreboard> => {
      const result = await api.GET('/contests/{key}/scoreboard', {
        params: { path: { key: contestKey } },
      });
      if (result.error) throw apiError(result, t('scoreboard.loadError'));
      return result.data;
    },
  });

  // Only for `canEdit`: the server decides who runs this contest, and the
  // board asks it rather than guessing from `me`. A failure here is not an
  // error state for the page — the board still renders, just without the
  // organiser's controls.
  const contest = useQuery({
    queryKey: ['contest', contestKey],
    queryFn: async (): Promise<ContestDetail | null> => {
      const { data } = await api.GET('/contests/{key}', { params: { path: { key: contestKey } } });
      return data ?? null;
    },
  });

  async function setDisqualified(username: string, disqualified: boolean): Promise<void> {
    setDqBusy(username);
    setDqError(null);
    try {
      const { error } = await api.PATCH('/contests/{key}/participants/{username}', {
        params: { path: { key: contestKey, username } },
        body: { disqualified },
      });
      if (error) {
        setDqError(error.detail ?? error.code);
        return;
      }
      await client.invalidateQueries({ queryKey: ['scoreboard', contestKey] });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setDqError(t('common.networkError'));
    } finally {
      setDqBusy(null);
    }
  }

    if (query.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return null;
  const canEdit = contest.data?.canEdit === true;

  // snake_case throughout: the scoreboard is served in the goldens' own shape,
  // field for field, and renaming it here would put a translation layer
  // between the contract and the screen.
  const { ranking, problems } = query.data;

  return (
    <section className="panel">
      <h1>{t('scoreboard.title')}</h1>
      <p>
        <Link to="/contests/$key" params={{ key: contestKey }}>
          {t('scoreboard.back')}
        </Link>
      </p>
      {/* `role="status"`, not `alert`: the board being frozen is the contest
          working as configured, not something going wrong. */}
      {query.data.frozen && query.data.frozenAt !== null ? (
        <p role="status">
          {t('scoreboard.frozen', { time: freezeInstant(query.data.frozenAt, locale) })}
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th className="num">{t('scoreboard.colRank')}</th>
            <th>{t('scoreboard.colParticipant')}</th>
            <th className="num">{t('scoreboard.colScore')}</th>
            <th className="num">{t('scoreboard.colTime')}</th>
            {problems.map((problem) => (
              <th key={problem.code} className="num">
                <Link to="/problems/$code" params={{ code: problem.code }}>
                  {problem.label}
                </Link>
              </th>
            ))}
            {canEdit ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {ranking.map((row) => (
            <tr
              key={`${row.participant}-${String(row.virtual)}`}
              className={row.is_disqualified ? 'dq' : undefined}
            >
              <td className="num">{row.rank}</td>
              <td>
                <Link to="/users/$username" params={{ username: row.participant }}>
                  {row.participant}
                </Link>
                {row.virtual !== 0 ? (
                  <span className="muted"> {t('scoreboard.virtual')}</span>
                ) : null}
                {row.is_disqualified ? (
                  <span className="muted"> {t('scoreboard.disqualified')}</span>
                ) : null}
              </td>
              <td className="num">{formatPoints(row.score)}</td>
              <td className="num">{row.cumtime}</td>
              {problems.map((problem) => (
                <td key={problem.code} className="num">
                  {cell(row.format_data[problem.code], row.pending?.[problem.code] ?? 0)}
                </td>
              ))}
              {canEdit ? (
                <td>
                  <button
                    type="button"
                    disabled={dqBusy === row.participant}
                    onClick={() => void setDisqualified(row.participant, !row.is_disqualified)}
                  >
                    {t(row.is_disqualified ? 'scoreboard.undq' : 'scoreboard.dq', { name: row.participant })}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {dqError ? <p role="alert">{dqError}</p> : null}
      {ranking.length === 0 ? <p className="muted">{t('scoreboard.empty')}</p> : null}
    </section>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { formatPoints } from '../format.js';
import { meQueryOptions } from '../me.js';
import { formatDateTime, useLocale, useT, type Locale, type MsgKey, type TFunction } from '../i18n/index.js';

type Contest = paths['/contests']['get']['responses'][200]['content']['application/json']['items'][number];
type ContestDetail = paths['/contests/{key}']['get']['responses'][200]['content']['application/json'];
type Scoreboard = paths['/contests/{key}/scoreboard']['get']['responses'][200]['content']['application/json'];

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
      const { data, error } = await api.GET('/contests', {});
      // `GET /contests` declares no error response, so `error` is typed
      // `never` — there is nothing to read a message off, and a transport
      // failure still lands here.
      if (error) throw new Error(t('contests.loadError'));
      return data;
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
      const { data, error } = await api.GET('/contests/{key}', { params: { path: { key: contestKey } } });
      if (error) throw new Error(error.detail ?? t('contest.notFound'));
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

      <p>
        <Link to="/contests/$key/scoreboard" params={{ key: contestKey }}>
          {t('contest.scoreboard')}
        </Link>{' '}
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
function cell(data: Cell | undefined): string {
  if (!data) return '\u2014';
  const minutes = Math.floor(data.time / 60);
  if (data.tries === undefined) {
    // The three non-icpc formats: points, with the scoring time beside a
    // nonzero score.
    return data.points > 0
      ? `${formatPoints(data.points)} \u00b7 ${String(minutes)}m`
      : formatPoints(data.points);
  }
  if (data.points > 0) {
    const marker = data.tries === 1 ? '+' : `+${String(data.tries - 1)}`;
    return `${formatPoints(data.points)} (${marker}, ${String(minutes)}m)`;
  }
  return data.tries > 0 ? `\u2212${String(data.tries)}` : '\u2014';
}

export function ScoreboardPage({ contestKey }: { contestKey: string }) {
  const t = useT();
  const query = useQuery({
    queryKey: ['scoreboard', contestKey],
    queryFn: async (): Promise<Scoreboard> => {
      const { data, error } = await api.GET('/contests/{key}/scoreboard', {
        params: { path: { key: contestKey } },
      });
      if (error) throw new Error(error.detail ?? t('scoreboard.loadError'));
      return data;
    },
  });

  if (query.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return null;

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
                  {cell(row.format_data[problem.code])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {ranking.length === 0 ? <p className="muted">{t('scoreboard.empty')}</p> : null}
    </section>
  );
}

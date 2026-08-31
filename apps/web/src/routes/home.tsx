/**
 * The landing page.
 *
 * Until now `/` rendered the submit form directly — a scaffold from Phase 1,
 * when submitting was the only thing the app could do and there was nowhere
 * else to go. That stopped being true the moment problems became browsable,
 * and it left the home page answering a question nobody asked: it offered to
 * grade a solution before showing what there was to solve.
 *
 * D138 — WHAT A SIGNED-IN HOME IS FOR. What replaced it was two links and a
 * paragraph, which on contest day said nothing about the contest. A pupil who
 * opens this app between 07:55 and 08:00 on a Saturday has exactly two
 * questions — "when does it start?" and "did my last submission pass?" — and
 * both answers were three taps away behind a nav.
 *
 * So the signed-in page now leads with the round that is running (or the next
 * one to start), carrying the live countdown and the phase chip the contest
 * list already uses, and then the reader's own last five verdicts as badges.
 * NO NEW ENDPOINT: this is `GET /contests` and `GET /submissions?user=…`,
 * both of which the app already calls elsewhere, both cached under the same
 * query keys — so opening the home page warms the contest list rather than
 * duplicating it.
 *
 * A VISITOR sees none of it and the page is byte-identical to what it was:
 * both queries are `enabled` only when there is a viewer, `/submissions` 401s
 * signed out, and `router.tsx` renders the sign-in form under this component.
 *
 * Still claims nothing it cannot serve: an empty panel says which emptiness
 * it is and offers the one action that resolves it, the way the submissions
 * list learned to (FE-1, finding 8).
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { verdictToken } from './submit.js';
import { ContestCountdown, PhaseChip } from './contests.js';
import { formatPoints } from '../format.js';
import { formatTimestamp, useLocale, useT, verdictName } from '../i18n/index.js';

/**
 * Structural, not imported from `@duckoj/contracts`. `apps/web` deliberately
 * depends on the generated SDK rather than the contracts package — contracts
 * pulls in zod and the OpenAPI generator, neither of which belongs in a
 * browser bundle. Naming only the fields this page reads keeps that boundary
 * intact.
 */
interface Viewer {
  username: string;
  displayName: string;
  globalRole: string;
}

type SubmissionRow =
  paths['/submissions']['get']['responses'][200]['content']['application/json']['items'][number];

/** How many of the reader's own attempts the page shows. */
const RECENT = 5;

/**
 * The one round worth naming on a landing page.
 *
 * A running contest always wins, however many there are — that is the one the
 * reader is IN. Otherwise the nearest start in the future; a finished round is
 * never chosen, because a home page counting down to nothing is worse than a
 * home page saying there is nothing. Ties break on the earlier start, so the
 * choice is stable between renders rather than depending on the server's
 * ordering.
 */
export function pickContest<T extends { startTime: string; endTime: string }>(
  items: readonly T[],
  now: number,
): T | null {
  const running = items
    .filter((c) => Date.parse(c.startTime) <= now && now <= Date.parse(c.endTime))
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  if (running[0] !== undefined) return running[0];
  const upcoming = items
    .filter((c) => Date.parse(c.startTime) > now)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  return upcoming[0] ?? null;
}

function ContestPanel({ enabled }: { enabled: boolean }) {
  const t = useT();
  const query = useQuery({
    // The SAME key `contests.tsx` uses, so the two screens share one answer.
    queryKey: ['contests'],
    queryFn: async () => {
      const result = await api.GET('/contests', {});
      if (result.error) throw new Error(t('contests.loadError'));
      return result.data;
    },
    enabled,
  });

  const contest = query.data ? pickContest(query.data.items, Date.now()) : null;

  return (
    <section className="home-panel">
      <h2>{t('home.yourContest')}</h2>
      {query.isPending ? <p className="muted">{t('common.loading')}</p> : null}
      {query.error ? <p role="alert">{t('contests.loadError')}</p> : null}
      {query.data && contest === null ? (
        <p className="muted">
          {t('home.noContest')} <Link to="/contests">{t('home.allContests')}</Link>
        </p>
      ) : null}
      {contest !== null ? (
        <>
          <p className="home-contest">
            <Link to="/contests/$key" params={{ key: contest.key }}>
              {contest.name}
            </Link>{' '}
            {/* The same chip and the same clock the contest screens use —
                never a second phase mapper or a second countdown (D134/D135). */}
            <PhaseChip phase={Date.parse(contest.startTime) > Date.now() ? 'upcoming' : 'running'} />
          </p>
          <ContestCountdown startTime={contest.startTime} endTime={contest.endTime} />
          <p>
            <Link to="/contests/$key/scoreboard" params={{ key: contest.key }}>
              {t('contest.scoreboard')}
            </Link>
          </p>
        </>
      ) : null}
    </section>
  );
}

function RecentPanel({ username, enabled }: { username: string; enabled: boolean }) {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const query = useQuery({
    queryKey: ['submissions', '', username, '', undefined],
    queryFn: async () => {
      const result = await api.GET('/submissions', { params: { query: { user: username } } });
      if (result.error || !result.data) throw new Error(t('submissions.loadError'));
      return result.data;
    },
    enabled,
  });

  const items = (query.data?.items ?? []).slice(0, RECENT);

  return (
    <section className="home-panel">
      <h2>{t('home.recent')}</h2>
      {query.isPending ? <p className="muted">{t('common.loading')}</p> : null}
      {query.error ? <p role="alert">{t('submissions.loadError')}</p> : null}
      {query.data && items.length === 0 ? (
        <p className="muted">
          {t('submissions.empty')} <Link to="/problems">{t('submissions.emptyAction')}</Link>
        </p>
      ) : null}
      {items.length > 0 ? (
        <>
          <ul className="home-verdicts">
            {items.map((s: SubmissionRow) => (
              <li key={s.id}>
                {/* The verdict FIRST: this list exists to answer "did it
                    pass?", and the answer must not be the thing the eye
                    arrives at last. Same `.badge` glyph+colour system as
                    everywhere else — never a second verdict renderer. */}
                <span
                  className={`badge ${verdictToken(s.verdict)}`}
                  {...(s.frozen
                    ? { title: t('submission.frozen') }
                    : s.verdict
                      ? { title: verdictName(t, s.verdict) }
                      : {})}
                >
                  {s.frozen ? '?' : (s.verdict ?? '—')}
                </span>{' '}
                <Link to="/problems/$code" params={{ code: s.problemCode }}>
                  {s.problemCode}
                </Link>
                <span className="home-verdict-meta">
                  {typeof s.points === 'number' && typeof s.maxPoints === 'number'
                    ? ` ${formatPoints(s.points)}/${formatPoints(s.maxPoints)}`
                    : ''}
                  {` · ${formatTimestamp(s.createdAt, locale, timeZone)}`}
                </span>
              </li>
            ))}
          </ul>
          <p>
            <Link to="/submissions">{t('home.allSubmissions')}</Link>
          </p>
        </>
      ) : null}
    </section>
  );
}

export function HomePage({ me }: { me: Viewer | null }) {
  const t = useT();
  const canAuthor = me?.globalRole === 'setter' || me?.globalRole === 'admin';

  return (
    <section>
      {/* The product name, not a translatable string. */}
      <h1>DuckOJ</h1>
      <p>{t('home.intro')}</p>

      {me ? (
        <div className="home-panels">
          <ContestPanel enabled={true} />
          <RecentPanel username={me.username} enabled={true} />
        </div>
      ) : null}

      <h2>{t('home.startHere')}</h2>
      <ul>
        <li>
          <Link to="/problems">{t('home.browseProblems')}</Link>
          {t('home.browseProblemsNote')}
        </li>
        <li>
          <a href="/api/v1/docs">{t('home.apiReference')}</a>
          {t('home.apiReferenceNote')}
        </li>
        {canAuthor ? (
          <li>
            {/* Three pieces rather than one string with markup in it: the
                role name is a `<code>` in the middle of a sentence whose two
                halves reorder between locales. */}
            <Link to="/problems/new">{t('home.createProblem')}</Link>
            {t('home.createProblemPrefix')}
            <code>{me?.globalRole}</code>
            {t('home.createProblemSuffix')}
          </li>
        ) : null}
      </ul>

      {me ? (
        <p>
          {t('home.signedInPrefix')}
          <strong>{me.displayName}</strong>
          {t('home.signedInMiddle')}
          <em>{t('common.submitSolution')}</em>
          {t('home.signedInSuffix')}
        </p>
      ) : (
        <>
          <h2>{t('home.signInHeading')}</h2>
          <p>{t('home.signInNote')}</p>
        </>
      )}
    </section>
  );
}

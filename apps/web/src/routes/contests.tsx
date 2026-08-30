import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { paths } from '@duckoj/sdk';
import { API_PREFIX } from '@duckoj/api-prefix';
import { api } from '../api.js';
import { apiError, read } from '../api-error.js';
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

/**
 * The organiser's results export (D71). Plain `<a>`s for the same reason the
 * booklet's is one: these are the API's own responses, outside the router's
 * tree, and the `.csv` is a download rather than a page.
 *
 * No `lang` — the sheet is names and numbers, and its headings are fixed.
 */
function resultsUrl(contestKey: string, extension: 'csv' | 'pdf'): string {
  return `${import.meta.env.VITE_API_ORIGIN ?? ''}/${API_PREFIX}/contests/${contestKey}/results.${extension}`;
}

/**
 * The certificates (D71/D74), beside the results sheet they are cut from.
 *
 * The route shipped with F12 and nothing on the site ever linked it, so the
 * one document a school actually prints was reachable only by typing a URL.
 * Same `<a>` as its two neighbours, and the API's own PDF.
 *
 * `top` is REQUIRED (`CertificatesQuery` refuses a request carrying neither
 * `top` nor `username`), and D74 makes it a bound on the RANK rather than a
 * count of sheets — `top=3` over ranks 1, 2, 3, 3 prints four certificates
 * rather than cutting through a tie. So the depth is the organiser's to
 * choose, on the screen, rather than a number this file invents for them.
 */
function certificatesUrl(contestKey: string, top: number): string {
  return `${import.meta.env.VITE_API_ORIGIN ?? ''}/${API_PREFIX}/contests/${contestKey}/certificates.pdf?top=${String(top)}`;
}

/** The contract's own bounds, restated so the box cannot build a 422. */
const CERTIFICATE_TOP_MIN = 1;
const CERTIFICATE_TOP_MAX = 1000;

/**
 * "Cấp tới hạng [3] — Giấy chứng nhận (PDF)".
 *
 * A number box beside the link, in the shape the similarity panel already
 * uses on this page: three is the podium a Vietnamese school prints most
 * often, and a teacher who wants one for every pupil raises it. The href
 * tracks the box, so what the organiser sees is what they download.
 */
function CertificatesLink({ contestKey }: { contestKey: string }) {
  const t = useT();
  const [top, setTop] = useState('3');
  // Clamped rather than validated: the box is a hint (a reader can still
  // type 0), and the one thing this link must never do is address a URL the
  // API answers 422 to.
  const parsed = Math.trunc(Number(top));
  const bounded = Number.isFinite(parsed)
    ? Math.min(CERTIFICATE_TOP_MAX, Math.max(CERTIFICATE_TOP_MIN, parsed))
    : CERTIFICATE_TOP_MIN;
  return (
    <>
      <label>
        {t('contest.certificatesTop')}{' '}
        <input
          type="number"
          min={CERTIFICATE_TOP_MIN}
          max={CERTIFICATE_TOP_MAX}
          value={top}
          onChange={(event) => setTop(event.target.value)}
        />
      </label>{' '}
      <a href={certificatesUrl(contestKey, bounded)}>{t('contest.certificates')}</a>{' '}
    </>
  );
}

type Contest = paths['/contests']['get']['responses'][200]['content']['application/json']['items'][number];
type ContestDetail = paths['/contests/{key}']['get']['responses'][200]['content']['application/json'];
type Scoreboard = paths['/contests/{key}/scoreboard']['get']['responses'][200]['content']['application/json'];
type Clarification =
  paths['/contests/{key}/clarifications']['get']['responses'][200]['content']['application/json']['items'][number];
type SimilarityReport =
  paths['/contests/{key}/similarity']['get']['responses'][200]['content']['application/json'];
type SimilarityRun = NonNullable<SimilarityReport['run']>;
type SimilarityPair = SimilarityRun['pairs'][number];
type SimilarityPairView =
  paths['/contests/{key}/similarity/{a}/{b}']['get']['responses'][200]['content']['application/json'];

/**
 * `2026-03-01T09:00:00Z` → `01/03/2026 16:00` (vi) or `3/1/2026 04:00` (en),
 * in the reader's own zone AND the reader's own date order — the day/month
 * order is not cosmetic, and a Vietnamese page printing `3/1/2026` for the
 * first of March is a wrong date, not an odd-looking one.
 */
function when(iso: string, locale: Locale, timeZone: string | null): string {
  return formatDateTime(iso, locale, timeZone);
}

/**
 * The organizations a contest is restricted to, as links (D56).
 *
 * Rendered wherever the contest is, list and page alike, because it is what
 * a competitor needs BEFORE pressing Join: the API refuses a non-member with
 * `contest_org_required`, and a refusal that does not name the school is a
 * refusal nobody can act on. The name is a link — every entity in this app
 * is — even though a private organization's own page 404s for a stranger:
 * naming it is the whole point, and where it leads is that page's decision.
 */
function OrgBadges({ orgs }: { orgs: Contest['orgs'] }) {
  const t = useT();
  if (orgs.length === 0) return null;
  return (
    <span className="muted">
      {t('contest.restrictedTo')}{' '}
      {orgs.map((org, index) => (
        <span key={org.slug}>
          {index > 0 ? ', ' : ''}
          <Link to="/orgs/$slug" params={{ slug: org.slug }}>
            {org.name}
          </Link>
        </span>
      ))}
    </span>
  );
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

/**
 * Is the contest inside its scoreboard-freeze window right now (D22)?
 *
 * Computed from the contest the page already holds rather than fetched: the
 * scoreboard's own `frozen` is per-PARTICIPATION (a virtual entrant is
 * frozen on their own clock), and this question is about the room the
 * organiser is answering questions in. `frozenLastMinutes === 0` is "no
 * freeze at all", so it can never be in one.
 */
function inFreezeWindow(
  contest: { endTime: string; frozenLastMinutes: number },
  phase: Phase,
): boolean {
  if (phase !== 'running' || contest.frozenLastMinutes <= 0) return false;
  return Date.now() >= Date.parse(contest.endTime) - contest.frozenLastMinutes * 60_000;
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
  const { locale, timeZone } = useLocale();
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
              <th>{t('contests.colOrgs')}</th>
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
                <td>{when(contest.startTime, locale, timeZone)}</td>
                <td>{when(contest.endTime, locale, timeZone)}</td>
                <td>{phaseLabel(t, phaseOf(contest))}</td>
                <td>{contest.orgs.length === 0 ? '—' : <OrgBadges orgs={contest.orgs} />}</td>
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
  const { locale, timeZone } = useLocale();
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
      // 404 is "you have not joined" — `myParticipation` says so in as many
      // words, and it is the state most readers of this page are in. 401 for
      // the moment a session lapses between `me` resolving and this asking.
      // Anything else is a failure, and used to render as "not joined": the
      // Join button offered to somebody already competing.
      return read(
        await api.GET('/contests/{key}/me', { params: { path: { key: contestKey } } }),
        t('contest.participationLoadError'),
        [401, 404],
      );
    },
    enabled: me.data != null,
  });

  /**
   * The teams this viewer may enter with (D99, amended by F-25).
   *
   * **One request**, `GET /users/me/teams?contest=` (F-25). It used to be one
   * per organization the contest named — twenty round trips at twenty schools,
   * on the page a whole province opens at the same minute. The `?contest=`
   * also makes the server say WHY a team may not enter, with the same code the
   * join would refuse with, so a choice is greyed out here for the server's
   * reason rather than a rule this file re-derived.
   *
   * `read()`, not `data?.items ?? []` (B-18): `openapi-fetch` resolves on an
   * HTTP error, so the bare form turns a 500 into an empty roster and tells a
   * competitor at the bell that they belong to no team — a fact asserted from
   * a question never answered.
   */
  const myTeams = useQuery({
    queryKey: ['my-teams', contestKey],
    enabled: me.data != null && contest.data?.participationMode === 'team',
    queryFn: async () => {
      const page = read(
        await api.GET('/users/me/teams', { params: { query: { contest: contestKey } } }),
        t('contest.teamsLoadError'),
      );
      return page?.items ?? [];
    },
  });
  const [pickedTeam, setPickedTeam] = useState('');
  const teamChoices = myTeams.data ?? [];
  // The first team that CAN enter, so the button is not pre-loaded with a
  // choice the server is about to refuse.
  const defaultTeam = teamChoices.find((team) => team.eligible !== false) ?? teamChoices[0];
  const teamSlug = pickedTeam === '' ? (defaultTeam?.slug ?? '') : pickedTeam;

  async function join(): Promise<void> {
    setJoinBusy(true);
    try {
      const { error } = await api.POST('/contests/{key}/join', {
        params: { path: { key: contestKey } },
        // `{}` for an individual contest — the server refuses a `teamSlug`
        // there rather than ignoring it, so the two must not be confused.
        body: contest.data?.participationMode === 'team' ? { teamSlug } : {},
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
  const isTeamContest = contest.data.participationMode === 'team';

  return (
    <section className="panel">
      <h1>{contest.data.name}</h1>
      <p className="muted">
        {contest.data.format} · {when(contest.data.startTime, locale, timeZone)} →{' '}
        {when(contest.data.endTime, locale, timeZone)} · {phaseLabel(t, phase)}
        {/* Said once, at the top: whether this is a team round decides what
            the Join button asks for and what the board will print (D99). */}
        {isTeamContest ? ` · ${t('contest.teamMode')}` : null}
      </p>
      {contest.data.orgs.length > 0 ? (
        <p>
          <OrgBadges orgs={contest.data.orgs} />
        </p>
      ) : null}
      {/* `canEdit` is the server's own answer, not a guess from `me` — see
          the field's note in the contract. */}
      {/* D88: a clone is a CREATE, so it lands on the create screen with the
          source named — the four things a copy cannot inherit (key, name,
          start, end) are asked for there, and the server copies the rest. */}
      {contest.data.canEdit ? (
        <p>
          <Link to="/contests/new" search={{ cloneFrom: contestKey }}>
            {t('contest.clone')}
          </Link>
        </p>
      ) : null}
      {contest.data.canEdit ? (
        <p>
          <Link to="/contests/$key/edit" params={{ key: contestKey }}>
            {t('contest.edit')}
          </Link>
        </p>
      ) : null}
      {/* The contest-day monitor (D95). Gated on `canEdit` — the server's own
          `canRunContest` — because the route behind it 403s for anybody
          else, and a link that only ever leads to a refusal is worse than no
          link. Its own page rather than a panel here: it polls every five
          seconds, which is not something to put on the tab two thousand
          competitors are holding open. */}
      {contest.data.canEdit ? (
        <p>
          <Link to="/contests/$key/monitor" params={{ key: contestKey }}>
            {t('contest.monitor')}
          </Link>
        </p>
      ) : null}

      {participation.isError ? (
        // Neither branch below is honest when the read failed. "Joined" would
        // invent a window; the Join button — which is what the swallow used
        // to render — offers a competitor mid-contest a button to enter the
        // contest they are already in, and pressing it is a write against a
        // state this page does not know.
        <p role="alert">{t('contest.participationLoadError')}</p>
      ) : joined ? (
        <>
          <p role="status">
            {participation.data!.virtual === 0
              ? t('contest.live')
              : t('contest.virtual', { n: participation.data!.virtual })}{' '}
            {t('contest.windowCloses', { when: when(participation.data!.endTime, locale, timeZone) })}
          </p>
          {/* The row is the TEAM's, and a member who never pressed Join is
              competing on it — saying so is the whole of what tells them
              their submissions count (D99). */}
          {participation.data!.team ? (
            <p role="status">
              {t('contest.teamAs', {
                name: participation.data!.team.name,
                members: participation.data!.team.members.join(', '),
              })}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {isTeamContest && myTeams.error ? (
            // Never the "you are on no team" line: this reader's teams are
            // unknown, which is a different thing to say and a different
            // thing to do about it.
            <p role="alert">{myTeams.error.message}</p>
          ) : null}
          {isTeamContest && !myTeams.error ? (
            teamChoices.length > 0 ? (
              <p>
                <label>
                  {t('contest.teamPick')}{' '}
                  <select value={teamSlug} onChange={(e) => setPickedTeam(e.target.value)}>
                    {teamChoices.map((team) => (
                      <option
                        key={`${team.orgSlug}/${team.slug}`}
                        value={team.slug}
                        // Disabled from the SERVER's verdict, not from a rule
                        // this page re-derived — and the reason is printed
                        // beside the name, so a teacher learns it before the
                        // click rather than from a 409 at the gun.
                        disabled={team.eligible === false}
                      >
                        {team.name} · {team.orgName}
                        {team.ineligibleReason
                          ? ` — ${t(`contest.teamReason.${team.ineligibleReason}`)}`
                          : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </p>
            ) : (
              <p className="muted">{t('contest.teamNone')}</p>
            )
          ) : null}
          <p>
            <button
              type="button"
              onClick={() => void join()}
              disabled={joinBusy || phase === 'upcoming' || (isTeamContest && teamSlug === '')}
            >
              {phase === 'finished' ? t('contest.joinVirtually') : t('contest.join')}
            </button>
            {phase === 'upcoming' ? <span className="muted"> {t('contest.notStarted')}</span> : null}
          </p>
        </>
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
        frozen={inFreezeWindow(contest.data, phase)}
        joined={joined}
        canEdit={contest.data.canEdit}
        problems={contest.data.problems.map((problem) => ({ code: problem.code, label: problem.label }))}
      />

      {/* Organisers only, and the server says who that is — `canEdit` is
          `canRunContest`'s own answer, the same predicate the three
          similarity routes refuse on. A competitor never sees this section,
          and there is no screen anywhere that shows them their own score
          (D77). */}
      {contest.data.canEdit ? (
        <SimilarityPanel
          contestKey={contestKey}
          byTeam={contest.data.participationMode === 'team'}
        />
      ) : null}

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
        {/* The API lets the people who run a contest export at any hour —
            the export is the live, unfrozen board, so the gate there is the
            person and not the clock (D71). The LINKS appear only once the
            contest is over, because that is when an organiser wants them and
            offering them mid-contest invites printing a board that is still
            moving. */}
        {contest.data.canEdit && phase === 'finished' ? (
          <>
            <a href={resultsUrl(contestKey, 'csv')}>{t('contest.resultsCsv')}</a>{' '}
            <a href={resultsUrl(contestKey, 'pdf')}>{t('contest.resultsPdf')}</a>{' '}
            <CertificatesLink contestKey={contestKey} />
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
  frozen,
  joined,
  canEdit,
  problems,
}: {
  contestKey: string;
  phase: Phase;
  frozen: boolean;
  joined: boolean;
  canEdit: boolean;
  problems: { code: string; label: string }[];
}) {
  const t = useT();
  const { locale, timeZone } = useLocale();
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

      {/* D22/D23 govern the scoreboard, never this feed: nothing in the API
          stops a published answer from naming a verdict, and nothing here
          adds such a check — an organiser sometimes MUST say "your solution
          is failing test 3". This is the reminder, on the screen where the
          mistake would be made, and only while the board is actually frozen;
          a warning that is always on is a warning nobody reads. */}
      {canEdit && frozen ? (
        <p role="note" className="muted">
          {t('clar.frozenWarning')}
        </p>
      ) : null}

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
      {/* D63 — the feed is capped, and a reader must not think they are
          looking at the whole conversation when they are not. */}
      {feed.data?.truncated ? <p className="muted">{t('clar.truncated')}</p> : null}

      {feed.data?.items.map((item) => (
        <article key={item.id}>
          <p className="muted">
            {item.question === null ? t('clar.announcement') : t('clar.question')} · {scope(item)} ·{' '}
            {when(item.createdAt, locale, timeZone)}
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
function freezeInstant(iso: string, locale: Locale, timeZone: string | null): string {
  const at = new Date(iso);
  const today = new Date();
  // The same-day test stays in the BROWSER's zone deliberately: it is asking
  // "does the reader think of this as today", and a reader looking at their
  // own screen thinks in the zone that screen is set to. The rendered value
  // then follows the chosen zone, so the two can disagree by an hour either
  // side of midnight — a residual, and the honest one of the two choices.
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  return sameDay ? formatTime(iso, locale, timeZone) : formatDateTime(iso, locale, timeZone);
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
  const { locale, timeZone } = useLocale();
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
  // board asks it rather than guessing from `me`. A failure here is still not
  // an error state for the page — the board renders without the organiser's
  // controls, which is the safe direction and stays deliberate.
  //
  // What changed is that it is no longer SILENT. The query throws, so the
  // failure reaches React Query and `contest.isError` is a fact this
  // component can read, rather than being erased into a `null` that is
  // indistinguishable from "you do not run this contest". 404 stays absent
  // because that genuinely is the answer for a contest the viewer may see the
  // board of but not the detail of.
  const contest = useQuery({
    queryKey: ['contest', contestKey],
    queryFn: async (): Promise<ContestDetail | null> => {
      return read(
        await api.GET('/contests/{key}', { params: { path: { key: contestKey } } }),
        t('contest.notFound'),
        [401, 403, 404],
      );
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
  // D99's sidecar: present only for a team contest, keyed by the name the
  // ranking row prints. `undefined` everywhere else, so every branch below
  // reads as "is this row a team".
  const teams = query.data.teams;

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
          {t('scoreboard.frozen', { time: freezeInstant(query.data.frozenAt, locale, timeZone) })}
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
                {teams?.[row.participant] ? (
                  // A team's name is not a username, so it must not link to a
                  // profile — that URL would 404. It links to the school that
                  // fielded it, and the people are links of their own; the
                  // `title` puts the roster in a tooltip for the ordinary
                  // case of scanning a board.
                  <>
                    <Link
                      to="/orgs/$slug"
                      params={{ slug: teams[row.participant]!.orgSlug }}
                      title={t('scoreboard.teamMembers', {
                        members: teams[row.participant]!.members.join(', '),
                      })}
                    >
                      {row.participant}
                    </Link>{' '}
                    <span className="muted">
                      {teams[row.participant]!.members.map((member, index) => (
                        <span key={member}>
                          {index > 0 ? ', ' : ''}
                          <Link to="/users/$username" params={{ username: member }}>
                            {member}
                          </Link>
                        </span>
                      ))}
                    </span>
                  </>
                ) : (
                  <Link to="/users/$username" params={{ username: row.participant }}>
                    {row.participant}
                  </Link>
                )}
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
                    onClick={() =>
                      void setDisqualified(
                        // The route is keyed by USERNAME, and a team row's
                        // `participant` is the team's name — which names no
                        // account. The sidecar carries the member whose
                        // account holds the participation, and moving that
                        // person moves the team's row (D37, D99). Sending
                        // `row.participant` here would 404 `user_not_found`.
                        teams?.[row.participant]?.captain ?? row.participant,
                        !row.is_disqualified,
                      )
                    }
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

/* ---------------------------------------------------- similarity (D77) */

/** `0.9231` → `92%`. A report is read in whole percents, never in decimals. */
function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

/**
 * "Kiểm tra trùng lặp" — the organiser's source-similarity report (D77).
 *
 * Rendered only for `canEdit`, which is the server's own `canRunContest`
 * answer rather than a guess from `me`: the three routes behind this panel
 * refuse on exactly that predicate, and a section offering a button the
 * server then refuses is worse than no section.
 *
 * **Polled only while a run is going.** `refetchInterval` is `2000` for a
 * `running` row and `false` for everything else — a finished report does not
 * change, and an organiser leaving this tab open for an afternoon must not
 * be a request every two seconds for the afternoon.
 */
/**
 * A competitor's label on the similarity report, as a link only when it names
 * an account.
 *
 * D99 labels a team contest's report by TEAM — `loadCandidates` substitutes
 * the team's name for the captain's username, precisely so three teammates'
 * attempts at one problem are one entry rather than three suspiciously
 * similar competitors. A team's name names no account, so `/users/{name}`
 * 404s: the same thing the scoreboard's own row already refuses to do, on
 * the screen an organiser opens when they think somebody cheated.
 *
 * Plain text rather than a link to the team's school, which the scoreboard
 * can offer: a pair carries only the label the run recorded, and inventing a
 * second lookup to hyperlink it would put a query on a table for a link
 * nobody asked for.
 */
function CompetitorLabel({ name, byTeam }: { name: string; byTeam: boolean }) {
  if (byTeam) return <span>{name}</span>;
  return (
    <Link to="/users/$username" params={{ username: name }}>
      {name}
    </Link>
  );
}

function SimilarityPanel({ contestKey, byTeam }: { contestKey: string; byTeam: boolean }) {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const client = useQueryClient();
  const [threshold, setThreshold] = useState('0.6');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const report = useQuery({
    queryKey: ['similarity', contestKey],
    queryFn: async (): Promise<SimilarityReport> => {
      const result = await api.GET('/contests/{key}/similarity', {
        params: { path: { key: contestKey } },
      });
      if (result.error) throw apiError(result, t('similarity.loadError'));
      return result.data;
    },
    refetchInterval: (query) => (query.state.data?.run?.status === 'running' ? 2000 : false),
  });

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { error: failed } = await api.POST('/contests/{key}/similarity', {
        params: { path: { key: contestKey } },
        body: { threshold: Number(threshold) },
      });
      if (failed) {
        setError(failed.detail ?? failed.code);
        return;
      }
      await client.invalidateQueries({ queryKey: ['similarity', contestKey] });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  const run_ = report.data?.run ?? null;
  const truncated = (run_?.problems ?? []).some((problem) => problem.truncated);

  return (
    <section>
      <h2>{t('similarity.title')}</h2>
      {/* The caution is not a footnote. D77's whole ruling is that a high
          score is a reason to LOOK, and printing the table without saying so
          invites an organiser to treat a number as a finding. */}
      <p className="muted">{t('similarity.caution')}</p>
      <p>
        <label>
          {t('similarity.threshold')}{' '}
          <input
            type="number"
            min="0.3"
            max="1"
            step="0.05"
            value={threshold}
            onChange={(event) => {
              setThreshold(event.target.value);
            }}
          />
        </label>{' '}
        <button type="button" disabled={busy || run_?.status === 'running'} onClick={() => void run()}>
          {t('similarity.run')}
        </button>
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {report.error ? <p role="alert">{report.error.message}</p> : null}

      {run_ === null ? <p className="muted">{t('similarity.never')}</p> : null}
      {/* `role="status"`, not `alert`: a run in progress is the feature
          working, not something going wrong. */}
      {run_?.status === 'running' ? <p role="status">{t('similarity.running')}</p> : null}
      {run_?.status === 'failed' ? <p role="alert">{t('similarity.failed')}</p> : null}
      {run_?.status === 'finished' ? (
        <p className="muted">
          {t('similarity.finished', {
            when: run_.finishedAt === null ? '' : formatDateTime(run_.finishedAt, locale, timeZone),
            people: String(run_.participants),
            threshold: percent(run_.threshold),
          })}
        </p>
      ) : null}
      {truncated ? <p role="status">{t('similarity.truncated')}</p> : null}

      {run_ !== null && run_.status === 'finished' && run_.pairs.length === 0 ? (
        <p className="muted">{t('similarity.none')}</p>
      ) : null}
      {run_ !== null && run_.pairs.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('similarity.colProblem')}</th>
              <th>{t('similarity.colPair')}</th>
              <th className="num">{t('similarity.colContainment')}</th>
              <th className="num">{t('similarity.colJaccard')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {run_.pairs.map((pair: SimilarityPair) => (
              <tr key={`${pair.problemCode}-${pair.a}-${pair.b}`}>
                <td>
                  <Link to="/problems/$code" params={{ code: pair.problemCode }}>
                    {pair.problemLabel}
                  </Link>
                </td>
                <td>
                  {/* Every entity is a hyperlink, competitors included — but
                      a team is not a competitor with an account (D99). */}
                  <CompetitorLabel name={pair.a} byTeam={byTeam} />
                  {' · '}
                  <CompetitorLabel name={pair.b} byTeam={byTeam} />
                </td>
                <td className="num">{percent(pair.containment)}</td>
                <td className="num">{percent(pair.jaccard)}</td>
                <td>
                  <Link
                    to="/contests/$key/similarity"
                    params={{ key: contestKey }}
                    search={{ a: pair.a, b: pair.b, problem: pair.problemCode }}
                  >
                    {t('similarity.compare')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/**
 * One source split into the plain runs and the matched ones.
 *
 * Built here rather than with `dangerouslySetInnerHTML`: the text is a
 * competitor's own program, and the one thing this screen must never do is
 * let a submission containing `<script>` become markup. React escapes every
 * segment because they are children, not HTML.
 */
export function markedSegments(
  source: string,
  spans: readonly { start: number; end: number }[],
): { text: string; matched: boolean }[] {
  const segments: { text: string; matched: boolean }[] = [];
  let cursor = 0;
  for (const span of spans) {
    // Defensive against a span the server and this string disagree about:
    // a bad range must render the source unhighlighted, never truncated.
    const start = Math.max(cursor, Math.min(span.start, source.length));
    const end = Math.max(start, Math.min(span.end, source.length));
    if (start > cursor) segments.push({ text: source.slice(cursor, start), matched: false });
    if (end > start) segments.push({ text: source.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), matched: false });
  return segments;
}

/** One competitor's source, with the matching regions marked. */
function MarkedSource({ side }: { side: SimilarityPairView['a'] }) {
  return (
    <pre>
      {/* The index IS the identity here: the segments are a partition of one
          immutable string, so segment 3 is always segment 3 and nothing is
          ever inserted between two of them. */}
      {markedSegments(side.source, side.spans).map((segment, index) =>
        segment.matched ? (
          <mark className="match" key={index}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </pre>
  );
}

/**
 * Two matched submissions side by side (D77).
 *
 * Its own route rather than a panel that expands in place, because it is a
 * thing an organiser links to: "look at these two" is a URL somebody sends
 * to a colleague, and a disclosure widget has no address.
 */
export function SimilarityPairPage({
  contestKey,
  a,
  b,
  problem,
}: {
  contestKey: string;
  a: string;
  b: string;
  problem?: string | undefined;
}) {
  const t = useT();
  // The pair view names its two sides the way the run recorded them, which
  // for a team contest is the TEAM's name (D99) — so this page has to know
  // which kind of contest it is showing before it can decide whether either
  // name is a profile. The same query key the contest page uses, so opening
  // this from there costs no second request.
  const contest = useQuery({
    queryKey: ['contest', contestKey],
    queryFn: async (): Promise<ContestDetail> => {
      const result = await api.GET('/contests/{key}', { params: { path: { key: contestKey } } });
      if (result.error) throw apiError(result, t('contest.notFound'));
      return result.data;
    },
  });
  const byTeam = contest.data?.participationMode === 'team';
  const query = useQuery({
    queryKey: ['similarity-pair', contestKey, a, b, problem ?? ''],
    queryFn: async (): Promise<SimilarityPairView> => {
      const result = await api.GET('/contests/{key}/similarity/{a}/{b}', {
        params: {
          path: { key: contestKey, a, b },
          query: problem === undefined ? {} : { problem },
        },
      });
      if (result.error) throw apiError(result, t('similarity.pairLoadError'));
      return result.data;
    },
  });

  return (
    <section className="panel">
      <h1>{t('similarity.pairTitle')}</h1>
      <p>
        <Link to="/contests/$key" params={{ key: contestKey }}>
          {t('similarity.back')}
        </Link>
      </p>
      <p className="muted">{t('similarity.caution')}</p>
      {query.isPending ? <p className="muted">{t('common.loading')}</p> : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {query.data ? (
        <>
          <p>
            <Link to="/problems/$code" params={{ code: query.data.problemCode }}>
              {query.data.problemLabel}
            </Link>{' '}
            <span className="muted">
              {t('similarity.pairScores', {
                containment: percent(query.data.containment),
                jaccard: percent(query.data.jaccard),
              })}
            </span>
          </p>
          <div className="side-by-side">
            {[query.data.a, query.data.b].map((side) => (
              <div key={side.submissionId}>
                <h2>
                  <CompetitorLabel name={side.username} byTeam={byTeam} />
                </h2>
                <p className="muted">
                  <Link to="/submissions/$id" params={{ id: String(side.submissionId) }}>
                    #{side.submissionId}
                  </Link>{' '}
                  {side.languageKey}
                </p>
                <MarkedSource side={side} />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

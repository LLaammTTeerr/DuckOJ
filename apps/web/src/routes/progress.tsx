/**
 * `/me/progress` — the student's own dashboard (D83), and the public panel
 * the same data feeds on somebody else's profile.
 *
 * Two SVGs and no chart library. A heatmap is 365 rectangles and a sparkline
 * is one `<polyline>`: pulling a charting bundle into a browser build for
 * that would cost more than the whole feature, and neither drawing needs an
 * axis, a scale or a tooltip engine — every cell carries its own `<title>`,
 * which is what a keyboard and a screen reader can actually reach.
 *
 * Both drawings are painted in `--fg` at varying opacity rather than in a
 * hue. `app.css`'s rule 1 reserves colour for verdicts (amended once, for
 * D46's rank scale); an activity calendar is a quantity, and a quantity is
 * legible as weight. It also means the drawings are correct in both schemes
 * with no second palette.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { rankBand } from '@duckoj/glicko2';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { meQueryOptions } from '../me.js';
import { formatDate, formatDateTime, rankTitle, useLocale, useT, verdictName, type TFunction } from '../i18n/index.js';
import { verdictToken } from './submit.js';

type MyProgress = paths['/users/me/progress']['get']['responses'][200]['content']['application/json'];
type PublicProgress =
  paths['/users/{username}/progress']['get']['responses'][200]['content']['application/json'];
type RatingPage =
  paths['/users/{username}/rating']['get']['responses'][200]['content']['application/json'];
type Heatmap = PublicProgress['heatmap'];
type TagBar = PublicProgress['byTag'][number];
type DifficultyBar = PublicProgress['byDifficulty'][number];

/* ------------------------------------------------------------ the drawings */

/** The pitch of one heatmap cell: 11px of square plus a 2px gutter. */
const CELL = 13;
const CELL_SIZE = 11;

/**
 * Five steps, not a continuous ramp: a reader compares a cell to its
 * neighbours, and a smooth gradient over a year of ones and twos is a wall
 * of near-identical greys. `0` is drawn — an empty day is part of the shape
 * of a week — at the faintest step there is.
 */
function shade(count: number): number {
  if (count <= 0) return 0.07;
  if (count <= 2) return 0.28;
  if (count <= 5) return 0.48;
  if (count <= 9) return 0.72;
  return 1;
}

/** `YYYY-MM-DD` arithmetic through UTC, matching the server's own `addDays`. */
function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * The activity calendar: one column per week, one row per weekday, every day
 * between the server's `from` and `to` inclusive.
 *
 * The days come back SPARSE (a day with nothing is absent, not a zero), so
 * this walks the range rather than the array — otherwise a quiet fortnight
 * would silently shorten the year.
 */
export function ActivityHeatmap({ heatmap, t }: { heatmap: Heatmap; t: TFunction }) {
  const counts = new Map(heatmap.days.map((day) => [day.date, day.count]));
  const span = daysBetween(heatmap.from, heatmap.to);
  // The weekday `from` fell on, so the first column starts where it should
  // rather than always at the top row.
  const offset = new Date(`${heatmap.from}T00:00:00Z`).getUTCDay();
  const cells = [];
  for (let index = 0; index <= span; index++) {
    const date = addDays(heatmap.from, index);
    const slot = index + offset;
    cells.push({
      date,
      count: counts.get(date) ?? 0,
      x: Math.floor(slot / 7) * CELL,
      y: (slot % 7) * CELL,
    });
  }
  const width = (Math.floor((span + offset) / 7) + 1) * CELL;
  const total = heatmap.days.reduce((sum, day) => sum + day.count, 0);

  return (
    // The same scroll wrapper the homework grid uses: a year of weeks is
    // wider than a phone, and a scroll container with no `tabindex` cannot
    // be reached from a keyboard at all (m21).
    <div className="grid-scroll" tabIndex={0} role="group" aria-label={t('progress.heatmap')}>
      <svg
        width={width}
        height={7 * CELL}
        viewBox={`0 0 ${String(width)} ${String(7 * CELL)}`}
        role="img"
        aria-label={t('progress.heatmapSummary', { n: total, zone: heatmap.timezone })}
      >
        {cells.map((cell) => (
          <rect
            key={cell.date}
            x={cell.x}
            y={cell.y}
            width={CELL_SIZE}
            height={CELL_SIZE}
            rx={2}
            fill="var(--fg)"
            fillOpacity={shade(cell.count)}
          >
            {/* Per-cell, so the date and its count are readable without a
                tooltip engine and survive with JavaScript doing nothing. */}
            <title>{t('progress.heatmapDay', { date: cell.date, n: cell.count })}</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

/** The rating history as one line. Nothing is drawn for fewer than two points. */
export function RatingSparkline({ ratings, t }: { ratings: number[]; t: TFunction }) {
  if (ratings.length < 2) return null;
  const width = 220;
  const height = 40;
  const low = Math.min(...ratings);
  const high = Math.max(...ratings);
  // A flat history would divide by zero; drawn down the middle instead.
  const span = high - low || 1;
  const points = ratings
    .map((rating, index) => {
      const x = (index / (ratings.length - 1)) * width;
      const y = height - ((rating - low) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="img"
      aria-label={t('progress.sparklineLabel', { from: ratings[0]!, to: ratings.at(-1)! })}
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--fg)"
        strokeOpacity={0.75}
        strokeWidth={1.5}
      />
    </svg>
  );
}

/** One bar: solved over attempted, scaled against the widest row on screen. */
function Bar({ solved, attempted, max }: { solved: number; attempted: number; max: number }) {
  const width = 120;
  const scale = max > 0 ? width / max : 0;
  return (
    <svg width={width} height={10} viewBox={`0 0 ${String(width)} 10`} aria-hidden="true">
      <rect x={0} y={0} width={attempted * scale} height={10} rx={2} fill="var(--fg)" fillOpacity={0.18} />
      <rect x={0} y={0} width={solved * scale} height={10} rx={2} fill="var(--fg)" fillOpacity={0.7} />
    </svg>
  );
}

/**
 * The two breakdowns, and the empty state that says which of the two
 * possible nothings this is.
 */
export function ProgressBars({
  byTag,
  byDifficulty,
  t,
  locale,
}: {
  byTag: TagBar[];
  byDifficulty: DifficultyBar[];
  t: TFunction;
  locale: string;
}) {
  const tagMax = Math.max(1, ...byTag.map((bar) => bar.attempted));
  const difficultyMax = Math.max(1, ...byDifficulty.map((bar) => bar.attempted));
  return (
    <>
      <h2>{t('progress.byTag')}</h2>
      {byTag.length === 0 ? (
        <p className="muted">{t('progress.noBars')}</p>
      ) : (
        <div className="table-wrap" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>{t('progress.colTag')}</th>
              <th className="num">{t('progress.colSolved')}</th>
              <th className="num">{t('progress.colAttempted')}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {byTag.map((bar) => (
              <tr key={bar.slug}>
                <td>
                  {/* Every entity is a hyperlink: a topic row goes to that
                      topic's problems, which is what a reader looking at a
                      thin bar wants next. */}
                  <Link to="/problems" search={{ tag: [bar.slug] }}>
                    {locale === 'vi' ? bar.nameVi : bar.nameEn}
                  </Link>
                </td>
                <td className="num">{bar.solved}</td>
                <td className="num">{bar.attempted}</td>
                <td>
                  <Bar solved={bar.solved} attempted={bar.attempted} max={tagMax} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2>{t('progress.byDifficulty')}</h2>
      {byDifficulty.length === 0 ? (
        <p className="muted">{t('progress.noBars')}</p>
      ) : (
        <div className="table-wrap" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>{t('progress.colDifficulty')}</th>
              <th className="num">{t('progress.colSolved')}</th>
              <th className="num">{t('progress.colAttempted')}</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {byDifficulty.map((bar) => (
              <tr key={bar.difficulty === null ? 'unrated' : String(bar.difficulty)}>
                <td>{bar.difficulty === null ? t('progress.unrated') : bar.difficulty}</td>
                <td className="num">{bar.solved}</td>
                <td className="num">{bar.attempted}</td>
                <td>
                  <Bar solved={bar.solved} attempted={bar.attempted} max={difficultyMax} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------- the public profile panel */

/**
 * The bars and the calendar on somebody else's profile.
 *
 * Silent on failure, like `OrgContests` and the sets section: a profile that
 * loaded is still a profile, and an alert about a panel nobody asked for is
 * noise on a page that is otherwise fine.
 */
export function PublicProgressPanel({ username }: { username: string }) {
  const t = useT();
  const { locale } = useLocale();
  const progress = useQuery({
    queryKey: ['user-progress', username],
    queryFn: async (): Promise<PublicProgress> => {
      const result = await api.GET('/users/{username}/progress', {
        params: { path: { username } },
      });
      if (result.error) throw apiError(result, t('progress.loadError'));
      return result.data;
    },
  });
  if (progress.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (!progress.data) return null;
  return (
    <>
      <h2>{t('progress.heatmap')}</h2>
      <ActivityHeatmap heatmap={progress.data.heatmap} t={t} />
      <ProgressBars
        byTag={progress.data.byTag}
        byDifficulty={progress.data.byDifficulty}
        t={t}
        locale={locale}
      />
    </>
  );
}

/* ------------------------------------------------------------- /me/progress */

export function MyProgressPage() {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const me = useQuery(meQueryOptions);
  const username = me.data?.username ?? null;

  const progress = useQuery({
    queryKey: ['my-progress'],
    // Never fires while signed out: the route answers 401, and an alert
    // saying so is a worse answer than the sign-in line below.
    enabled: username !== null,
    queryFn: async (): Promise<MyProgress> => {
      const result = await api.GET('/users/me/progress');
      if (result.error) throw apiError(result, t('progress.loadError'));
      return result.data;
    },
  });

  // The rating history, paged exactly as the profile pages it — one shared
  // shape, and the sparkline is a second reading of the same rows rather
  // than a second endpoint.
  const rating = useInfiniteQuery({
    queryKey: ['user-rating', username ?? ''],
    enabled: username !== null,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<RatingPage> => {
      const query: { cursor?: string } = {};
      if (pageParam !== undefined) query.cursor = pageParam;
      const result = await api.GET('/users/{username}/rating', {
        params: { path: { username: username! }, query },
      });
      if (result.error) throw apiError(result, t('user.ratingLoadError'));
      return result.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const ratings = (rating.data?.pages.flatMap((page) => page.items) ?? []).map(
    (event) => event.ratingAfter,
  );

  if (me.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (!me.data) {
    return (
      <section className="panel">
        <h1>{t('progress.title')}</h1>
        <p className="muted">{t('progress.signedOut')}</p>
      </section>
    );
  }
  if (progress.error) return <p role="alert">{progress.error.message}</p>;
  if (progress.isPending || !progress.data) return <p className="muted">{t('common.loading')}</p>;

  const data = progress.data;
  const solved = data.byDifficulty.reduce((sum, bar) => sum + bar.solved, 0);
  const attempted = data.byDifficulty.reduce((sum, bar) => sum + bar.attempted, 0);
  // The current rating, read off the LAST rated contest rather than from a
  // third request: `rating_event` is the only thing that ever writes
  // `users.rating`, so the two cannot disagree, and `GET /auth/me` — the
  // viewer this page already has — does not carry it.
  const currentRating = ratings.at(-1) ?? null;
  const band = currentRating === null ? null : rankBand(currentRating);

  return (
    <section className="panel">
      <h1>{t('progress.title')}</h1>
      <p className="muted">
        {t('progress.subtitle', { zone: data.heatmap.timezone })}
        {' · '}
        <Link to="/users/$username" params={{ username: me.data.username }}>
          {t('progress.publicProfile')}
        </Link>
      </p>

      <div className="stats">
        <div className="stat">
          <span>{t('progress.solved')}</span>
          <strong>{solved}</strong>
        </div>
        <div className="stat">
          <span>{t('progress.attempted')}</span>
          <strong>{attempted}</strong>
        </div>
        <div className="stat">
          <span>{t('progress.streak')}</span>
          <strong>{t('progress.days', { n: data.streak.current })}</strong>
        </div>
        <div className="stat">
          <span>{t('progress.longestStreak')}</span>
          <strong>{t('progress.days', { n: data.streak.longest })}</strong>
        </div>
      </div>

      <h2>{t('progress.rating')}</h2>
      <p>
        {band === null ? (
          <span className="muted">{t('user.unrated')}</span>
        ) : (
          <>
            {/* D46: the band's key IS the CSS class, and its words are data. */}
            <span className={`rank ${band.key}`}>{rankTitle(locale, band)}</span>
            {` · ${String(currentRating)}`}
          </>
        )}
      </p>
      <RatingSparkline ratings={ratings} t={t} />

      <h2>{t('progress.heatmap')}</h2>
      <ActivityHeatmap heatmap={data.heatmap} t={t} />

      <ProgressBars byTag={data.byTag} byDifficulty={data.byDifficulty} t={t} locale={locale} />

      <h2>{t('progress.upcoming')}</h2>
      {data.upcomingContests.length === 0 ? (
        <p className="muted">{t('progress.noContests')}</p>
      ) : (
        <ul>
          {data.upcomingContests.map((contest) => (
            <li key={contest.key}>
              <Link to="/contests/$key" params={{ key: contest.key }}>
                {contest.name}
              </Link>
              {` · ${t('progress.endsAt', {
                at: formatDateTime(contest.endsAt, locale, timeZone),
              })}`}
            </li>
          ))}
        </ul>
      )}

      <h2>{t('progress.homework')}</h2>
      {data.homework.length === 0 ? (
        <p className="muted">{t('progress.noHomework')}</p>
      ) : (
        <div className="table-wrap" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>{t('progress.colSet')}</th>
              <th>{t('progress.colSchool')}</th>
              <th>{t('progress.colDeadline')}</th>
              <th className="num">{t('progress.colDone')}</th>
            </tr>
          </thead>
          <tbody>
            {data.homework.map((set) => (
              <tr key={`${set.orgSlug}/${set.slug}`}>
                <td>
                  <Link
                    to="/orgs/$slug/sets/$setSlug"
                    params={{ slug: set.orgSlug, setSlug: set.slug }}
                  >
                    {set.name}
                  </Link>
                </td>
                <td>
                  <Link to="/orgs/$slug" params={{ slug: set.orgSlug }}>
                    {set.orgName}
                  </Link>
                </td>
                <td>{formatDate(set.deadline, locale, timeZone)}</td>
                <td className="num">{`${String(set.solved)}/${String(set.total)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2>{t('progress.recent')}</h2>
      {data.recent.length === 0 ? (
        <p className="muted">{t('progress.noRecent')}</p>
      ) : (
        <div className="table-wrap" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>{t('progress.colProblem')}</th>
              <th>{t('progress.colVerdict')}</th>
              <th>{t('progress.colWhen')}</th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link to="/problems/$code" params={{ code: row.problemCode }}>
                    {row.problemName}
                  </Link>
                </td>
                <td>
                  <Link to="/submissions/$id" params={{ id: String(row.id) }}>
                    {row.verdict === null ? (
                      <span className="muted">{t('progress.pending')}</span>
                    ) : (
                      <span className={`badge ${verdictToken(row.verdict)}`}>
                        {verdictName(t, row.verdict)}
                      </span>
                    )}
                  </Link>
                </td>
                <td>{formatDateTime(row.createdAt, locale, timeZone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}

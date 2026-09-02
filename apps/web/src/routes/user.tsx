import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { rankBand } from '@duckoj/glicko2';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { formatPoints } from '../format.js';
import { formatDate, rankTitle, useLocale, useT } from '../i18n/index.js';
import { Avatar } from '../avatar.js';
import { PublicProgressPanel } from './progress.js';

type Profile = paths['/users/{username}']['get']['responses'][200]['content']['application/json'];
type RatingPage =
  paths['/users/{username}/rating']['get']['responses'][200]['content']['application/json'];

export function UserPage({ username }: { username: string }) {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const profile = useQuery({
    queryKey: ['user', username],
    queryFn: async (): Promise<Profile> => {
      const result = await api.GET('/users/{username}', { params: { path: { username } } });
      if (result.error) throw apiError(result, t('user.notFound'));
      return result.data;
    },
  });

  // A page at a time, appended — the same `useInfiniteQuery` shape the
  // problems, submissions and roster lists use. A rating history grows by a
  // row per rated contest and never shrinks.
  const rating = useInfiniteQuery({
    queryKey: ['user-rating', username],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<RatingPage> => {
      // Throws rather than folding a failure into `[]`. An empty history and
      // a failed request look identical to `data ?? []`, and the screen
      // renders the first as "has not been rated" — a statement about this
      // person that a 500 or a dropped connection has no business making.
      //
      // `exactOptionalPropertyTypes`: an absent cursor is an omitted key,
      // never `cursor: undefined` (problems.tsx documents the same rule).
      const query: { cursor?: string } = {};
      if (pageParam !== undefined) query.cursor = pageParam;
      const result = await api.GET('/users/{username}/rating', {
        params: { path: { username }, query },
      });
      if (result.error) throw apiError(result, t('user.ratingLoadError'));
      return result.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const ratingEvents = rating.data?.pages.flatMap((page) => page.items) ?? [];

  if (profile.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (profile.error) return <p role="alert">{profile.error.message}</p>;
  if (!profile.data) return null;

  const user = profile.data;

  return (
    <section className="panel">
      {/* The profile header, larger than the in-line placements. Decorative:
          the name is the <h1> beside it. */}
      <div className="avatar-name">
        <Avatar name={user.displayName} size={44} />
        <h1>{user.displayName}</h1>
      </div>
      <p className="muted">
        {user.username}
        {user.globalRole !== 'user' ? ` · ${user.globalRole}` : ''}
        {user.country ? ` · ${user.country}` : ''} ·{' '}
        {t('user.memberSince', { date: formatDate(user.createdAt, locale, timeZone) })}
      </p>
      {/* D197. The name above is this account's USERNAME standing in for a
          display name this deployment does not disclose to this reader, and
          the About section below it is withheld for the same reason. D187's
          rule: a reader who is being shown less has to be able to see that
          they are — otherwise the handle reads as the pupil's chosen name and
          an empty About reads as a pupil who wrote nothing. */}
      {user.identityRedacted ? <p className="muted">{t('user.identityHidden')}</p> : null}
      {user.about ? <p>{user.about}</p> : null}

      <h2>{t('user.statistics')}</h2>
      {/* Counted over public problems only, so these numbers mean the same
          thing to every reader — including the user themselves. */}
      <table>
        <tbody>
          <tr>
            <th>{t('user.solved')}</th>
            <td className="num">{user.stats.solvedCount}</td>
          </tr>
          <tr>
            <th>{t('user.points')}</th>
            <td className="num">{formatPoints(user.stats.points)}</td>
          </tr>
          <tr>
            <th>{t('user.submissions')}</th>
            <td className="num">{user.stats.submissionCount}</td>
          </tr>
          <tr>
            <th>{t('user.rating')}</th>
            <td className="num">
              {/* The band's TITLE and its COLOUR both come from
                  `packages/glicko2`'s data table (D46): the words are the
                  row's own two spellings, and the key is the CSS modifier
                  class app.css matches its muted rank scale on. Renaming or
                  recolouring a rank is an edit to that table plus one
                  `.rank.<key>` rule — never a change here. The scale is
                  deliberately outside the verdict palette (app.css rule 1,
                  amended for D46). */}
              {user.rating === null ? (
                t('user.unrated')
              ) : (
                <>
                  <span className={`rank ${rankBand(user.rating).key}`}>
                    {rankTitle(locale, rankBand(user.rating))}
                  </span>
                  {` \u00b7 ${String(user.rating)}`}
                </>
              )}
              {user.maxRating !== null && user.maxRating !== user.rating
                ? t('user.peak', { n: user.maxRating })
                : ''}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>{t('user.ratingHistory')}</h2>
      {ratingEvents.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('user.colContest')}</th>
              <th className="num">{t('user.colRank')}</th>
              <th className="num">{t('user.colRating')}</th>
              <th className="num">{t('user.colChange')}</th>
            </tr>
          </thead>
          <tbody>
            {ratingEvents.map((event) => (
              <tr key={event.contestKey}>
                <td>
                  <Link to="/contests/$key" params={{ key: event.contestKey }}>
                    {event.contestName}
                  </Link>
                </td>
                <td className="num">{event.rank}</td>
                <td className="num">{event.ratingAfter}</td>
                {/* Signed, because "+12" and "12" read very differently to
                    someone scanning a column of them. */}
                <td className="num">{event.delta > 0 ? `+${String(event.delta)}` : event.delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : rating.error ? (
        <p role="alert">{rating.error.message}</p>
      ) : rating.isPending ? (
        <p className="muted">{t('common.loading')}</p>
      ) : (
        <p className="muted">{t('user.notRated')}</p>
      )}

      {rating.hasNextPage ? (
        <p>
          <button
            type="button"
            onClick={() => void rating.fetchNextPage()}
            disabled={rating.isFetchingNextPage}
          >
            {t('common.loadMore')}
          </button>
        </p>
      ) : null}

      {/* The public third of the progress page (D83): the bars and the
          calendar, over public problems only. Nothing the owner's own
          `/me/progress` adds — no streak, no homework, no contests they are
          sitting — reaches this screen, because none of it is anybody
          else's business. */}
      <PublicProgressPanel username={username} />

      <p>
        <Link to="/submissions" search={{ user: username }}>
          {t('user.theirSubmissions')}
        </Link>
      </p>
    </section>
  );
}

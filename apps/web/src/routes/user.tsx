import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { rankBand } from '@duckoj/glicko2';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { formatPoints } from '../format.js';
import { formatDate, rankTitle, useLocale, useT } from '../i18n/index.js';

type Profile = paths['/users/{username}']['get']['responses'][200]['content']['application/json'];
type RatingEvent =
  paths['/users/{username}/rating']['get']['responses'][200]['content']['application/json'][number];

export function UserPage({ username }: { username: string }) {
  const t = useT();
  const { locale } = useLocale();
  const profile = useQuery({
    queryKey: ['user', username],
    queryFn: async (): Promise<Profile> => {
      const result = await api.GET('/users/{username}', { params: { path: { username } } });
      if (result.error) throw apiError(result, t('user.notFound'));
      return result.data;
    },
  });

  const rating = useQuery({
    queryKey: ['user-rating', username],
    queryFn: async (): Promise<RatingEvent[]> => {
      const { data } = await api.GET('/users/{username}/rating', {
        params: { path: { username } },
      });
      return data ?? [];
    },
  });

  if (profile.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (profile.error) return <p role="alert">{profile.error.message}</p>;
  if (!profile.data) return null;

  const user = profile.data;

  return (
    <section className="panel">
      <h1>{user.displayName}</h1>
      <p className="muted">
        {user.username}
        {user.globalRole !== 'user' ? ` · ${user.globalRole}` : ''}
        {user.country ? ` · ${user.country}` : ''} ·{' '}
        {t('user.memberSince', { date: formatDate(user.createdAt, locale) })}
      </p>
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
      {rating.data && rating.data.length > 0 ? (
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
            {rating.data.map((event) => (
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
      ) : (
        <p className="muted">{t('user.notRated')}</p>
      )}

      <p>
        <Link to="/submissions" search={{ user: username }}>
          {t('user.theirSubmissions')}
        </Link>
      </p>
    </section>
  );
}

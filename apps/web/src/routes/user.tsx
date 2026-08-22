import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';

type Profile = paths['/users/{username}']['get']['responses'][200]['content']['application/json'];
type RatingEvent =
  paths['/users/{username}/rating']['get']['responses'][200]['content']['application/json'][number];

export function UserPage({ username }: { username: string }) {
  const profile = useQuery({
    queryKey: ['user', username],
    queryFn: async (): Promise<Profile> => {
      const { data, error } = await api.GET('/users/{username}', {
        params: { path: { username } },
      });
      if (error) throw new Error(error.detail ?? 'No such user.');
      return data;
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

  if (profile.isPending) return <p className="muted">Loading…</p>;
  if (profile.error) return <p role="alert">{profile.error.message}</p>;
  if (!profile.data) return null;

  const user = profile.data;

  return (
    <section className="panel">
      <h1>{user.displayName}</h1>
      <p className="muted">
        {user.username}
        {user.globalRole !== 'user' ? ` · ${user.globalRole}` : ''}
        {user.country ? ` · ${user.country}` : ''} · member since{' '}
        {new Date(user.createdAt).toLocaleDateString()}
      </p>
      {user.about ? <p>{user.about}</p> : null}

      <h2>Statistics</h2>
      {/* Counted over public problems only, so these numbers mean the same
          thing to every reader — including the user themselves. */}
      <table>
        <tbody>
          <tr>
            <th>Problems solved</th>
            <td className="num">{user.stats.solvedCount}</td>
          </tr>
          <tr>
            <th>Points</th>
            <td className="num">{user.stats.points}</td>
          </tr>
          <tr>
            <th>Submissions</th>
            <td className="num">{user.stats.submissionCount}</td>
          </tr>
          <tr>
            <th>Rating</th>
            <td className="num">
              {user.rating === null ? 'unrated' : user.rating}
              {user.maxRating !== null && user.maxRating !== user.rating
                ? ` (peak ${String(user.maxRating)})`
                : ''}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Rating history</h2>
      {rating.data && rating.data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Contest</th>
              <th className="num">Rank</th>
              <th className="num">Rating</th>
              <th className="num">Change</th>
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
        <p className="muted">Not rated yet.</p>
      )}

      <p>
        <Link to="/submissions">All submissions</Link>
      </p>
    </section>
  );
}

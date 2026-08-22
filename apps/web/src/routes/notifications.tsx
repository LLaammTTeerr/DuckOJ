/**
 * The notification feed (D14). Each known kind renders as a sentence with
 * the link a reader would want next; an unknown kind falls back to its own
 * name rather than vanishing — the server may grow kinds before this file
 * learns them.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';

type Feed = paths['/notifications']['get']['responses'][200]['content']['application/json'];
type Item = Feed['items'][number];

export const notificationsQueryOptions = {
  queryKey: ['notifications'] as const,
  queryFn: async (): Promise<Feed | null> => {
    // 401/403 (signed out, or a token session) is an ordinary state here,
    // not an error — the bell simply has nothing to show.
    const { data } = await api.GET('/notifications');
    return data ?? null;
  },
};

function line(item: Item): React.ReactNode {
  const p = item.payload;
  const slug = typeof p.orgSlug === 'string' ? p.orgSlug : '';
  switch (item.kind) {
    case 'org_join_requested':
      return (
        <>
          {typeof p.username === 'string' ? p.username : 'Someone'} asked to join{' '}
          <Link to="/orgs/$slug" params={{ slug }}>
            {slug}
          </Link>
          .
        </>
      );
    case 'org_join_decided':
      return (
        <>
          Your request to join{' '}
          <Link to="/orgs/$slug" params={{ slug }}>
            {slug}
          </Link>{' '}
          was {p.approved === true ? 'approved' : 'declined'}.
        </>
      );
    case 'role_granted':
      return <>You are now a {typeof p.globalRole === 'string' ? p.globalRole : 'user'}.</>;
    default:
      return <>{item.kind}</>;
  }
}

export function NotificationsPage() {
  const client = useQueryClient();
  const feed = useQuery(notificationsQueryOptions);

  async function markAllRead(): Promise<void> {
    const { data } = await api.POST('/notifications/read');
    if (data) client.setQueryData(notificationsQueryOptions.queryKey, data);
  }

  if (feed.isPending) return <p className="muted">Loading…</p>;
  if (!feed.data) return <p>Sign in to see notifications.</p>;

  return (
    <section className="panel">
      <h1>Notifications</h1>
      {feed.data.unreadCount > 0 ? (
        <p>
          <button type="button" onClick={() => void markAllRead()}>
            Mark all read ({feed.data.unreadCount})
          </button>
        </p>
      ) : null}
      {feed.data.items.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <table>
          <tbody>
            {feed.data.items.map((item) => (
              <tr key={item.id}>
                {/* Unread rows carry the row text in strong weight — weight,
                    not colour (app.css rule 1). */}
                <td>{item.readAt === null ? <strong>{line(item)}</strong> : line(item)}</td>
                <td className="num">{new Date(item.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

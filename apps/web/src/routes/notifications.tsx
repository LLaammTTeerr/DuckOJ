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
import {
  formatRelative,
  formatTimestamp,
  globalRoleLabel,
  useLocale,
  useT,
  type TFunction,
} from '../i18n/index.js';

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

/**
 * One feed row as a sentence with the link a reader wants next.
 *
 * Split into prefix/suffix keys rather than one string with a `{org}`
 * placeholder: the org name is a `<Link>`, a React node a flat catalogue
 * cannot hold, and Vietnamese does not put the two halves in the same order
 * English does (`của bạn` lands after the org, not before it). An unknown
 * kind still falls back to its own name — the server may grow kinds before
 * this file learns them, and a blank row would hide that.
 */
function line(t: TFunction, item: Item): React.ReactNode {
  const p = item.payload;
  const slug = typeof p.orgSlug === 'string' ? p.orgSlug : '';
  switch (item.kind) {
    case 'org_join_requested':
      return (
        <>
          {t('notifications.joinRequestedPrefix', {
            name: typeof p.username === 'string' ? p.username : t('notifications.someone'),
          })}
          <Link to="/orgs/$slug" params={{ slug }}>
            {slug}
          </Link>
          {t('notifications.joinRequestedSuffix')}
        </>
      );
    case 'org_join_decided':
      return (
        <>
          {t('notifications.joinDecidedPrefix')}
          <Link to="/orgs/$slug" params={{ slug }}>
            {slug}
          </Link>
          {p.approved === true
            ? t('notifications.joinDecidedApproved')
            : t('notifications.joinDecidedDeclined')}
        </>
      );
    case 'role_granted':
      return (
        <>
          {t('notifications.roleGranted', {
            role: globalRoleLabel(t, typeof p.globalRole === 'string' ? p.globalRole : 'user'),
          })}
        </>
      );
    // The three D31 kinds. All carry `contestKey`, and all read better as
    // a sentence wrapped around a link to the contest than as a bare line —
    // the reader's next move is always "open the contest and look".
    case 'clarification_answered':
    case 'clarification_published':
    case 'contest_announcement': {
      const contestKey = typeof p.contestKey === 'string' ? p.contestKey : '';
      const name = typeof p.contestName === 'string' ? p.contestName : contestKey;
      const prefix =
        item.kind === 'clarification_answered'
          ? 'notifications.clarificationAnsweredPrefix'
          : item.kind === 'clarification_published'
            ? 'notifications.clarificationPublishedPrefix'
            : 'notifications.contestAnnouncementPrefix';
      const suffix =
        item.kind === 'clarification_answered'
          ? 'notifications.clarificationAnsweredSuffix'
          : item.kind === 'clarification_published'
            ? 'notifications.clarificationPublishedSuffix'
            : 'notifications.contestAnnouncementSuffix';
      return (
        <>
          {t(prefix)}
          <Link to="/contests/$key" params={{ key: contestKey }}>
            {name}
          </Link>
          {t(suffix)}
        </>
      );
    }
    case 'totp_reset':
      return <>{t('notifications.totpReset')}</>;
    default:
      return <>{item.kind}</>;
  }
}

export function NotificationsPage() {
  const t = useT();
  const { locale } = useLocale();
  const client = useQueryClient();
  const feed = useQuery(notificationsQueryOptions);

  async function markAllRead(): Promise<void> {
    const { data } = await api.POST('/notifications/read');
    if (data) client.setQueryData(notificationsQueryOptions.queryKey, data);
  }

  if (feed.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (!feed.data) return <p>{t('notifications.gate')}</p>;

  return (
    <section className="panel">
      <h1>{t('notifications.title')}</h1>
      {feed.data.unreadCount > 0 ? (
        <p>
          <button type="button" onClick={() => void markAllRead()}>
            {t('notifications.markAllRead', { count: feed.data.unreadCount })}
          </button>
        </p>
      ) : null}
      {feed.data.items.length === 0 ? (
        <p className="muted">{t('notifications.empty')}</p>
      ) : (
        <table>
          <tbody>
            {feed.data.items.map((item) => (
              <tr key={item.id}>
                {/* Unread rows carry the row text in strong weight — weight,
                    not colour (app.css rule 1). */}
                <td>
                  {item.readAt === null ? <strong>{line(t, item)}</strong> : line(t, item)}
                </td>
                {/* A feed is the one place "when" means "how long ago" —
                    Intl.RelativeTimeFormat, in the active locale, with the
                    absolute instant still one hover away. */}
                <td className="num" title={formatTimestamp(item.createdAt, locale)}>
                  {formatRelative(item.createdAt, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

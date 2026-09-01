/**
 * The notification feed (D14). Each known kind renders as a sentence with
 * the link a reader would want next; an unknown kind falls back to its own
 * name rather than vanishing — the server may grow kinds before this file
 * learns them.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { read } from '../api-error.js';
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
    // not an error — the bell simply has nothing to show. Every OTHER status
    // was folded into that same silence, so a 500 rendered as an empty inbox
    // and a bell reading zero: the two failures a reader is least able to
    // distinguish from "nothing has happened".
    return read(await api.GET('/notifications'), 'notifications', [401, 403]);
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
    // `scripts/org-import.ts` tells an org's owners that a roster landed
    // (D14, in the import's own transaction). It was the one kind the server
    // ships that this switch had never learned, so it fell through to the
    // fallback and printed `org_members_imported` — an untranslated
    // snake_case identifier, in front of a teacher, on the one screen whose
    // whole job is to be read in Vietnamese.
    //
    // The payload's `by` is a user ID, not a username, so it is deliberately
    // not in the sentence: a bare number names nobody, and resolving it would
    // be a second request for a line that already says what happened.
    case 'org_members_imported':
      return (
        <>
          {t('notifications.membersImportedPrefix', {
            count: typeof p.count === 'number' ? p.count : 0,
          })}
          <Link to="/orgs/$slug" params={{ slug }}>
            {slug}
          </Link>
          {t('notifications.membersImportedSuffix')}
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
    // The D31 kinds, plus D137's. All carry `contestKey`, and all read better
    // as a sentence wrapped around a link to the contest than as a bare line —
    // the reader's next move is always "open the contest and look".
    //
    // `clarification_answered_team` is a separate kind rather than the same
    // sentence sent to more people: "your question" is simply false told to a
    // teammate who did not ask it, and Vietnamese marks the difference in one
    // word (`của bạn` / `của đội bạn`).
    case 'clarification_answered':
    case 'clarification_answered_team':
    case 'clarification_published':
    case 'contest_announcement': {
      const contestKey = typeof p.contestKey === 'string' ? p.contestKey : '';
      const name = typeof p.contestName === 'string' ? p.contestName : contestKey;
      const prefix =
        item.kind === 'clarification_answered'
          ? 'notifications.clarificationAnsweredPrefix'
          : item.kind === 'clarification_answered_team'
            ? 'notifications.clarificationAnsweredTeamPrefix'
            : item.kind === 'clarification_published'
              ? 'notifications.clarificationPublishedPrefix'
              : 'notifications.contestAnnouncementPrefix';
      const suffix =
        item.kind === 'clarification_answered' || item.kind === 'clarification_answered_team'
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
    // D109 — a reply on your problem comment. Links to the problem, whose
    // discussion section is where the reply lives; the reader's next move is
    // always to open it.
    case 'problem_comment_reply': {
      const problemCode = typeof p.problemCode === 'string' ? p.problemCode : '';
      const name = typeof p.problemName === 'string' ? p.problemName : problemCode;
      return (
        <>
          {t('notifications.commentReplyPrefix')}
          <Link to="/problems/$code" params={{ code: problemCode }}>
            {name}
          </Link>
          {t('notifications.commentReplySuffix')}
        </>
      );
    }
    case 'totp_reset':
      return <>{t('notifications.totpReset')}</>;
    // D39. No link: the security page is one nav click away, and the sentence
    // is the whole of what the reader has to do.
    case 'totp_recovery_codes_exhausted':
      return <>{t('notifications.recoveryCodesExhausted')}</>;
    default:
      return <>{item.kind}</>;
  }
}

export function NotificationsPage() {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feed = useQuery(notificationsQueryOptions);

  /**
   * The one write on this screen, in the shape every other write in this app
   * uses (see contests.tsx's `patchRow`): a busy flag so one click is one
   * POST, a `catch` because openapi-fetch RETHROWS network-level failures
   * rather than resolving them to `{ error }`, and a visible error either
   * way. Without all three, a click during an outage was an unhandled
   * promise rejection and a button that looked like it had done nothing.
   *
   * The response is written into `notificationsQueryOptions.queryKey` — the
   * same `['notifications']` entry the shell's bell reads (router.tsx's
   * `ShellNav` spreads this very object), so the count in the nav clears with
   * the rows on the page rather than lingering until the next poll.
   */
  async function markAllRead(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { data, error: failure } = await api.POST('/notifications/read');
      if (failure) {
        setError(failure.detail ?? t('notifications.markAllReadError'));
        return;
      }
      client.setQueryData(notificationsQueryOptions.queryKey, data);
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  if (feed.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (!feed.data) return <p>{t('notifications.gate')}</p>;

  return (
    <section className="panel">
      <h1>{t('notifications.title')}</h1>
      {feed.data.unreadCount > 0 ? (
        <p>
          <button type="button" disabled={busy} onClick={() => void markAllRead()}>
            {t('notifications.markAllRead', { count: feed.data.unreadCount })}
          </button>
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {feed.data.items.length === 0 ? (
        <div className="empty">
          <p>{t('notifications.empty')}</p>
          <p>
            <Link to="/contests">{t('notifications.emptyAction')}</Link>
          </p>
        </div>
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
                <td className="num" title={formatTimestamp(item.createdAt, locale, timeZone)}>
                  {formatRelative(item.createdAt, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* D187. The window said out loud. The feed is capped at fifty and stays
          capped — a notification is acted on within days and one press clears
          the whole backlog — but a reader with sixty unread and fifty rows was
          being asked to reconcile two numbers with nothing to reconcile them
          by. This is the sentence the clarification feed already prints under
          its own cap. */}
      {feed.data.truncated ? <p className="muted">{t('notifications.truncated')}</p> : null}
    </section>
  );
}

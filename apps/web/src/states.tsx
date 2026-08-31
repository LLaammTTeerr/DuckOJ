/**
 * The four states nobody designs — loading, empty, failing, offline — as
 * components, because until this file every screen wrote its own and got the
 * same three things wrong (D143, D144, D145).
 *
 * Measured on the live stack through `page.route`, before any of this
 * existed:
 *
 *   1. **A 500 said "there is no such contest."** `apiError(result, fallback)`
 *      takes ONE fallback for every status, and the fallback a detail screen
 *      naturally picks is its not-found sentence. So `/contests/probe-cup`
 *      under a broken API painted `Không có kỳ thi này.` — a competitor at the
 *      bell told their round does not exist. The problem page, the org page
 *      and the submission page all did the same.
 *   2. **Nothing offered a way to ask again.** Not one failing screen in the
 *      app had a retry control; the only way back was a reload, which on a
 *      school connection re-downloads the bundle.
 *   3. **A 401 printed the server's English `detail` verbatim** — "You must be
 *      signed in." on a Vietnamese page. `api-error.ts` rules that the detail
 *      is shown rather than translated, and that ruling is kept: it just stops
 *      being the FIRST thing the reader meets.
 *   4. **`navigator.onLine` appeared nowhere in `src/`.** A dead wifi looked
 *      exactly like a working one, right down to a scoreboard that had quietly
 *      stopped polling (TanStack Query's `networkMode: 'online'` pauses
 *      refetches while the browser reports offline — the numbers freeze and
 *      the page says nothing).
 */
import { useEffect, useState, type ReactElement } from 'react';
import { ApiError } from './api-error.js';
import { formatTime, useLocale, useT, type MsgKey, type TFunction } from './i18n/index.js';

/* ────────────────────────── failing ────────────────────────────────────── */

/**
 * Which sentence a status deserves, and whether asking again could help.
 *
 * `null` means "the message the thrower chose is already the right one" —
 * that is the 404 case, where the caller's fallback IS the answer.
 */
function headlineKey(status: number): MsgKey | null {
  if (status === 0) return 'common.networkError';
  if (status >= 500) return 'common.serverError';
  if (status === 401) return 'common.signInRequired';
  if (status === 403) return 'common.forbidden';
  return null;
}

/** Retryable is exactly `src/query.ts`'s rule, said again for a human. */
function isRetryable(status: number): boolean {
  return status === 0 || status >= 500;
}

function statusOf(error: unknown): number {
  return error instanceof ApiError ? error.status : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/** Only what the SERVER wrote — never this app's own fallback. */
function detailOf(error: unknown): string {
  return error instanceof ApiError ? (error.detail ?? '') : '';
}

export interface LoadErrorProps {
  /** Whatever the query threw. A non-`ApiError` is a network-level failure. */
  error: unknown;
  /**
   * A translated sentence naming WHAT failed to load — "Không tải được bảng
   * vận hành." — for a screen that shows several panels at once.
   *
   * It leads, and the status sentence follows it, because on the admin
   * dashboard or the problem list the operator's first question is which of
   * six panels is down, not what HTTP did. Omitted on a detail screen, where
   * the panel IS the page and naming it would only say the heading again.
   */
  what?: string | undefined;
  /** `query.refetch`. Rendered only when the status says a retry could work. */
  onRetry?: (() => void) | undefined;
}

/**
 * The one way a read failure is shown in this app.
 *
 * Two lines at most: a translated sentence chosen by STATUS, then — when the
 * server sent wording of its own that the headline replaced — that wording,
 * muted, so a teacher on the phone to an operator can still read out what the
 * server actually said.
 */
export function LoadError({ error, what, onRetry }: LoadErrorProps): ReactElement {
  const t = useT();
  const status = statusOf(error);
  const key = headlineKey(status);
  const said = key === null ? messageOf(error) : t(key);
  const headline = what ?? said;
  // Only the server's own wording, and never twice: for a 404 the detail IS
  // the headline. A fallback this app invented is not news to the reader.
  const detail = detailOf(error);
  const alsoSay = key !== null && detail !== '' && detail !== said;
  return (
    <p role="alert" className="load-error">
      <span>{headline}</span>
      {what !== undefined && said !== what ? <span className="muted">{said}</span> : null}
      {alsoSay ? <span className="muted">{t('common.serverSaid', { detail })}</span> : null}
      {onRetry && isRetryable(status) ? (
        <button type="button" onClick={onRetry}>
          {t('common.retry')}
        </button>
      ) : null}
    </p>
  );
}

/**
 * A write that failed, said in words, with the server's `code` beside it.
 *
 * The authoring screens used to render the bare `code` AS the whole message:
 * `setAttachError(error.code)` put `package_not_found` on screen as a
 * sentence, in six places. app.css has carried a rule for
 * `[role="alert"] code` — and a comment saying these screens "surface the
 * server's error code verbatim … monospace because it is an identifier a
 * setter will paste into a search" — since before any of them; no call site
 * ever emitted the `<code>` the rule was written for. So: the sentence a
 * setter can act on, and the identifier they can search for, both.
 */
/** What a screen holds in state for one `CodeAlert`; `null` is "no error". */
export type CodeAlertState = { message: string; code?: string | undefined } | null;

export function CodeAlert({ message, code }: { message: string; code?: string | undefined }): ReactElement {
  return (
    <p role="alert">
      {message}
      {code !== undefined && code !== '' ? (
        <>
          {' '}
          <code>{code}</code>
        </>
      ) : null}
    </p>
  );
}

/**
 * The last failure of a POLLING query, which TanStack Query throws away.
 *
 * Measured, not guessed. `/contests/probe-cup/monitor` answered 500 to seven
 * requests over sixteen seconds in Chromium and the page said "Đang tải…"
 * for every one of them. The reason is in `fetchState()`: when a query starts
 * a fetch and `data === undefined`, it resets `error` to null and `status` to
 * `'pending'`. A screen that polls therefore spends almost all of a total
 * outage back in the loading state — the error is visible only in the gap
 * between the last retry giving up and the next interval firing, and with a
 * 5 s interval against a ~7 s retry chain that gap is most of the time zero.
 *
 * `isError` has the same hole, so this is not a `.error` vs `.isError`
 * choice: the fact has to be remembered outside the query. Forgotten the
 * moment a fetch actually succeeds, which is what `hasData` is for.
 */
export function useLastError(error: unknown, hasData: boolean): unknown {
  const [last, setLast] = useState<unknown>(null);
  useEffect(() => {
    if (error != null) setLast(error);
    else if (hasData) setLast(null);
  }, [error, hasData]);
  return error ?? last;
}

/* ────────────────────────── loading ────────────────────────────────────── */

export interface SkeletonRowsProps {
  /** How many rows the real table is about to draw. */
  rows: number;
  /** How many columns it has, so the shape does not change when data lands. */
  columns: number;
}

/**
 * Placeholder rows inside a real `<tbody>`, so the table head, the filters and
 * everything below the table keep the position they will have when the data
 * arrives.
 *
 * The bug this replaces: `if (query.isPending) return <p>Đang tải…</p>` throws
 * the whole screen away and paints one grey line at the top of an empty page.
 * On a slow connection that is what a contestant looks at, and when the answer
 * lands every pixel on the page moves.
 *
 * `aria-hidden` on each row, not `role="presentation"`: these ARE table rows
 * to the layout and nothing at all to a screen reader, which is told what is
 * happening once, by the caller's own live region, rather than eight times.
 */
export function SkeletonRows({ rows, columns }: SkeletonRowsProps): ReactElement {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} aria-hidden="true" className="skeleton-row">
          {Array.from({ length: columns }, (_, column) => (
            <td key={column}>
              <span className="skeleton" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** The same reserved space where the content is a block, not a table. */
export function SkeletonBlock({ lines = 3 }: { lines?: number }): ReactElement {
  return (
    <div aria-hidden="true" className="skeleton-block">
      {Array.from({ length: lines }, (_, line) => (
        <span key={line} className="skeleton" />
      ))}
    </div>
  );
}

/* ────────────────────────── offline ────────────────────────────────────── */

/**
 * Whether the browser thinks it has a connection, kept current.
 *
 * `navigator.onLine` is famously optimistic — a captive portal reports `true`
 * — so this is not a claim that requests will succeed. It is the one signal
 * that is instant and free, and the case it gets right is the one a school
 * hall produces: the access point drops and every page in the room freezes.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => {
    try {
      return globalThis.navigator.onLine !== false;
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    globalThis.addEventListener('online', up);
    globalThis.addEventListener('offline', down);
    // The event may already have fired between the initial render and this
    // effect — on a slow first paint that window is real.
    setOnline(globalThis.navigator.onLine !== false);
    return () => {
      globalThis.removeEventListener('online', up);
      globalThis.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/**
 * One line under the nav, on every screen, whenever the connection is down.
 *
 * `role="status"` rather than `role="alert"`: it is a standing fact about the
 * page, not an interruption, and a contestant mid-keystroke must not have
 * focus or the reading order disturbed by it.
 */
export function OfflineBanner(): ReactElement | null {
  const t = useT();
  const online = useOnline();
  if (online) return null;
  return (
    <p role="status" className="offline-banner">
      {t('common.offline')}
    </p>
  );
}

/* ────────────────────────── stale ──────────────────────────────────────── */

export interface StaleNoticeProps {
  /** `query.dataUpdatedAt` — 0 before the first success. */
  updatedAt: number;
  /** The poll interval, so "late" is defined by the screen's own promise. */
  intervalMs: number;
  /** Injectable for the tests; defaults to the wall clock. */
  now?: number;
}

/** How late a poll has to be before the numbers stop being "live". */
const STALE_FACTOR = 3;

/**
 * "Cập nhật lúc 09:41:07" under a screen that polls — and "chưa cập nhật kể
 * từ …" once the poll is more than three intervals late.
 *
 * The monitor promises a refresh every five seconds in its own subtitle and
 * had no way to say it had stopped keeping that promise. Offline, TanStack
 * Query pauses the refetch entirely, so the last good numbers sit there
 * looking exactly as authoritative as they did a second after they arrived.
 */
export function StaleNotice({ updatedAt, intervalMs, now }: StaleNoticeProps): ReactElement | null {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const [tick, setTick] = useState(() => now ?? Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [now]);
  if (updatedAt === 0) return null;
  const at = now ?? tick;
  const time = formatTime(new Date(updatedAt).toISOString(), locale, timeZone);
  const stale = at - updatedAt > intervalMs * STALE_FACTOR;
  // A live region ONLY once it has gone stale. A vintage stamp is not news —
  // announcing "updated at 09:41:07" every poll would make a screen reader
  // unusable on the monitor, and it is also the first `role="status"` in the
  // document, which is what the contest page's own phase banner is.
  if (!stale) {
    return <p className="stale-notice muted">{t('common.updatedAt', { time })}</p>;
  }
  return (
    <p role="status" className="stale-notice is-stale">
      {t('common.stale', { time })}
    </p>
  );
}

/**
 * The same sentence for a `t` that is already in hand — used by the screens
 * that build their message outside JSX.
 */
export function loadErrorMessage(t: TFunction, error: unknown): string {
  const key = headlineKey(statusOf(error));
  return key === null ? messageOf(error) : t(key);
}

/**
 * `/submissions/$id` — the page that did not exist: every old submission
 * was a dead end (the list showed a row, and nothing could be opened).
 * Renders the same `VerdictPanel` the live submit screen uses — one
 * verdict renderer in this app, never a second copy — plus the metadata
 * row and the source.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { meQueryOptions } from '../me.js';
import { VerdictPanel, type SubmissionDetail } from './submit.js';
import { formatTimestamp, useLocale, useT } from '../i18n/index.js';

type SubmissionDiff = paths['/submissions/{id}/diff']['get']['responses'][200]['content']['application/json'];

export function SubmissionPage({ id }: { id: number }) {
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const [rejudgeError, setRejudgeError] = useState<string | null>(null);
  // D21: the rejudge answers with the rated contests it touched, and does NOT
  // replay their ratings — nothing else in the product will say so, so the
  // screen that fired it has to.
  const [reRate, setReRate] = useState<string[]>([]);
  // A rejudge resets the verdict and re-queues grading; firing it twice
  // races two claims for one submission, so the button is held down until
  // the request settles — the same busy-flag shape every write on this app
  // uses.
  const [rejudgeBusy, setRejudgeBusy] = useState(false);
  // D111: the "So sánh với lần nộp trước" toggle. The diff is only fetched
  // once the reader asks for it.
  const [showDiff, setShowDiff] = useState(false);

  const t = useT();
  const { locale, timeZone } = useLocale();
  // The router builds this prop as `Number(params.id)` off a path segment, so
  // `/submissions/abc` arrives here as `NaN` — and every id the API could
  // possibly hold is a positive integer. Without this the page asked for
  // `GET /submissions/NaN` (422 from the API, 502 on the retry) and rendered
  // TanStack Query's own internal message, `["submission",null] data is
  // undefined`, as the page body. A URL typed wrong is a not-found, and
  // saying so costs no request at all.
  const idIsUsable = Number.isInteger(id) && id > 0;
  const query = useQuery({
    queryKey: ['submission', id],
    enabled: idIsUsable,
    queryFn: async (): Promise<SubmissionDetail> => {
      const result = await api.GET('/submissions/{id}', { params: { path: { id } } });
      // `apiError`, not `new Error`: the status has to survive so the query
      // client can tell a 404 (final) from a 503 (worth asking again).
      if (result.error) throw apiError(result, t('submission.notFound'));
      return result.data;
    },
  });

  // D111: does the viewer have an earlier own attempt to this problem? Only
  // the id — the diff itself is fetched on demand below. Gated on the source
  // being readable at all: comparing against a submission whose source is
  // withheld (D27) could never render, so the toggle is not offered.
  const sourceVisible = query.data !== undefined && !query.data.sourceHidden && query.data.source !== null;
  const previous = useQuery({
    queryKey: ['submission-previous', id],
    enabled: idIsUsable && sourceVisible,
    queryFn: async (): Promise<number | null> => {
      const result = await api.GET('/submissions/{id}/previous', { params: { path: { id } } });
      if (result.error) throw apiError(result, t('submission.compareError'));
      // `?? null`, never bare: React Query rejects an `undefined` result, and
      // the id is the one field this query exists to read.
      return result.data.previousId ?? null;
    },
  });
  const previousId = previous.data ?? null;
  const diff = useQuery({
    queryKey: ['submission-diff', id, previousId],
    enabled: showDiff && previousId !== null,
    queryFn: async (): Promise<SubmissionDiff> => {
      const result = await api.GET('/submissions/{id}/diff', {
        params: { path: { id }, query: { against: previousId! } },
      });
      if (result.error) throw apiError(result, t('submission.compareError'));
      return result.data;
    },
  });

  async function rejudge(): Promise<void> {
    // `confirm` rather than a bespoke dialog: this throws away a verdict the
    // submitter has already seen, and there is no undo.
    if (!window.confirm(t('submission.rejudgeConfirm', { id: String(id) }))) {
      return;
    }
    setRejudgeBusy(true);
    setRejudgeError(null);
    setReRate([]);
    try {
      const { data, error } = await api.POST('/admin/submissions/{id}/rejudge', {
        params: { path: { id } },
      });
      if (error) {
        setRejudgeError(error.detail ?? error.code);
        return;
      }
      setReRate(data.ratedContestKeys);
      // The submission is `queued` again the moment this returns; the cached
      // copy on screen still shows the old verdict.
      await client.invalidateQueries({ queryKey: ['submission', id] });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setRejudgeError(t('common.networkError'));
    } finally {
      setRejudgeBusy(false);
    }
  }

  // Before `isPending`: a disabled query is pending forever, so the order
  // here is what stops an unusable id from painting "Loading…" for good.
  if (!idIsUsable) return <p role="alert">{t('submission.notFound')}</p>;
  if (query.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return null;
  const s = query.data;

  return (
    <section className="panel">
      <h1>{t('submission.title', { id: s.id })}</h1>
      <p>
        <Link to="/problems/$code" params={{ code: s.problemCode }}>
          {s.problemCode}
        </Link>{' '}
        {/* `languageKey` is the API's own enum value, and `ms`/`KB` are unit
            symbols — neither is translated (see i18n/en.ts). The timestamp
            now follows the active locale rather than the browser's. */}· {s.languageKey} ·{' '}
        {formatTimestamp(s.createdAt, locale, timeZone)}
        {s.timeMs !== null ? ` · ${String(s.timeMs)} ms` : ''}
        {s.memoryKb !== null ? ` · ${String(s.memoryKb)} KB` : ''}
      </p>
      {/* The contest this attempt belongs to, when it belongs to one. Until
          this line, a contest submission and a practice submission to the
          same problem rendered identically — the one fact that distinguishes
          them was in the database and nowhere on screen. */}
      {s.contestKey ? (
        <p>
          {t('submission.contest')}:{' '}
          <Link to="/contests/$key" params={{ key: s.contestKey }}>
            {s.contestLabel ?? s.contestKey}
          </Link>
        </p>
      ) : null}
      {me.data?.globalRole === 'admin' ? (
        <p>
          <button type="button" disabled={rejudgeBusy} onClick={() => void rejudge()}>
            {t('submission.rejudge')}
          </button>
        </p>
      ) : null}
      {rejudgeError ? <p role="alert">{rejudgeError}</p> : null}
      {/* Contest keys are content — never translated, joined with the plain
          list separator both locales use. */}
      {reRate.length > 0 ? (
        <p role="status">{t('rejudge.reRate', { keys: reRate.join(', ') })}</p>
      ) : null}
      <VerdictPanel submission={s} />
      <h2>{t('submission.source')}</h2>
      {/* D27: `sourceHidden` rather than `source === null`, so "withheld
          during a contest" never reads as "this submission was empty". */}
      {s.sourceHidden ? (
        <p className="muted">{t('submission.sourceHidden')}</p>
      ) : (
        <pre>
          <code>{s.source}</code>
        </pre>
      )}
      {/* D111: offered only when the viewer can read this source AND has an
          earlier own attempt to the same problem. */}
      {sourceVisible && previousId !== null ? (
        <p>
          <button type="button" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? t('submission.compareHide') : t('submission.compare')}
          </button>
        </p>
      ) : null}
      {showDiff && previousId !== null ? (
        <section>
          <h2>
            {t('submission.compareHeading')}{' '}
            <Link to="/submissions/$id" params={{ id: String(previousId) }}>
              #{previousId}
            </Link>
          </h2>
          {diff.isPending ? <p className="muted">{t('common.loading')}</p> : null}
          {diff.error ? <p role="alert">{diff.error.message}</p> : null}
          {diff.data ? <DiffView diff={diff.data} /> : null}
        </section>
      ) : null}
      <p>
        <Link to="/submissions">{t('common.allSubmissions')}</Link>
      </p>
    </section>
  );
}

/**
 * The server-computed unified diff (D111), rendered as one monospace column.
 * Added/removed lines carry a +/− glyph as real text — never colour alone
 * (B-20/D77) — plus a `.sr-only` label, and a tint derived from the verdict
 * palette in `app.css`.
 */
function DiffView({ diff }: { diff: SubmissionDiff }) {
  const t = useT();
  if (diff.hunks.length === 0) {
    return <p className="muted">{t('submission.compareEmpty')}</p>;
  }
  return (
    <pre className="diff">
      {diff.hunks.map((hunk, hunkIndex) => (
        // The hunk index is the identity: hunks are an ordered partition of
        // one immutable diff, and nothing is inserted between two of them.
        <span key={hunkIndex}>
          <span className="diff-hunk-header">
            {`@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`}
            {'\n'}
          </span>
          {hunk.lines.map((line, lineIndex) => {
            const cls =
              line.op === 'added' ? 'diff-line diff-added' : line.op === 'removed' ? 'diff-line diff-removed' : 'diff-line';
            const glyph = line.op === 'added' ? '+' : line.op === 'removed' ? '−' : ' ';
            const label =
              line.op === 'added'
                ? t('submission.compareAdded')
                : line.op === 'removed'
                  ? t('submission.compareRemoved')
                  : '';
            return (
              <span className={cls} key={lineIndex}>
                <span className="diff-glyph" aria-hidden="true">
                  {glyph}
                </span>
                {label ? <span className="sr-only">{label}: </span> : null}
                {line.text}
                {'\n'}
              </span>
            );
          })}
        </span>
      ))}
    </pre>
  );
}

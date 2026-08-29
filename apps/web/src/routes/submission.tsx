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
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';
import { VerdictPanel, type SubmissionDetail } from './submit.js';
import { formatTimestamp, useLocale, useT } from '../i18n/index.js';

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

  const t = useT();
  const { locale } = useLocale();
  const query = useQuery({
    queryKey: ['submission', id],
    queryFn: async (): Promise<SubmissionDetail> => {
      const { data, error } = await api.GET('/submissions/{id}', {
        params: { path: { id } },
      });
      if (error) throw new Error(error.detail ?? t('submission.notFound'));
      return data;
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
        {formatTimestamp(s.createdAt, locale)}
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
      <pre>
        <code>{s.source}</code>
      </pre>
      <p>
        <Link to="/submissions">{t('common.allSubmissions')}</Link>
      </p>
    </section>
  );
}

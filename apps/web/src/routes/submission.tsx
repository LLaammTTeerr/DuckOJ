/**
 * `/submissions/$id` — the page that did not exist: every old submission
 * was a dead end (the list showed a row, and nothing could be opened).
 * Renders the same `VerdictPanel` the live submit screen uses — one
 * verdict renderer in this app, never a second copy — plus the metadata
 * row and the source.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api.js';
import { VerdictPanel, type SubmissionDetail } from './submit.js';
import { formatTimestamp, useLocale, useT } from '../i18n/index.js';

export function SubmissionPage({ id }: { id: number }) {
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

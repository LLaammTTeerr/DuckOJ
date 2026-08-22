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

export function SubmissionPage({ id }: { id: number }) {
  const query = useQuery({
    queryKey: ['submission', id],
    queryFn: async (): Promise<SubmissionDetail> => {
      const { data, error } = await api.GET('/submissions/{id}', {
        params: { path: { id } },
      });
      if (error) throw new Error(error.detail ?? 'No such submission.');
      return data;
    },
  });

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return null;
  const s = query.data;

  return (
    <section className="panel">
      <h1>Submission #{s.id}</h1>
      <p>
        <Link to="/problems/$code" params={{ code: s.problemCode }}>
          {s.problemCode}
        </Link>{' '}
        · {s.languageKey} · {new Date(s.createdAt).toLocaleString()}
        {s.timeMs !== null ? ` · ${String(s.timeMs)} ms` : ''}
        {s.memoryKb !== null ? ` · ${String(s.memoryKb)} KB` : ''}
      </p>
      <VerdictPanel submission={s} />
      <h2>Source</h2>
      <pre>
        <code>{s.source}</code>
      </pre>
      <p>
        <Link to="/submissions">All submissions</Link>
      </p>
    </section>
  );
}

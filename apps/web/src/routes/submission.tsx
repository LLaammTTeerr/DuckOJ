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

export function SubmissionPage({ id }: { id: number }) {
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const [rejudgeError, setRejudgeError] = useState<string | null>(null);
  // A rejudge resets the verdict and re-queues grading; firing it twice
  // races two claims for one submission, so the button is held down until
  // the request settles — the same busy-flag shape every write on this app
  // uses.
  const [rejudgeBusy, setRejudgeBusy] = useState(false);

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

  async function rejudge(): Promise<void> {
    // `confirm` rather than a bespoke dialog: this throws away a verdict the
    // submitter has already seen, and there is no undo.
    if (!window.confirm(`Rejudge submission #${String(id)}? Its current verdict is discarded.`)) {
      return;
    }
    setRejudgeBusy(true);
    setRejudgeError(null);
    try {
      const { error } = await api.POST('/admin/submissions/{id}/rejudge', {
        params: { path: { id } },
      });
      if (error) {
        setRejudgeError(error.detail ?? error.code);
        return;
      }
      // The submission is `queued` again the moment this returns; the cached
      // copy on screen still shows the old verdict.
      await client.invalidateQueries({ queryKey: ['submission', id] });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setRejudgeError('Could not reach the server. Check your connection and try again.');
    } finally {
      setRejudgeBusy(false);
    }
  }

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
      {me.data?.globalRole === 'admin' ? (
        <p>
          <button type="button" disabled={rejudgeBusy} onClick={() => void rejudge()}>
            Rejudge
          </button>
        </p>
      ) : null}
      {rejudgeError ? <p role="alert">{rejudgeError}</p> : null}
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

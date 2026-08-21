import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { formatMemoryMb } from './problems.js';

type Revision =
  paths['/problems/{code}/revisions']['get']['responses'][200]['content']['application/json'][number];

// Head…tail, never middle-elided (mockup-v1.html, screen 4's note): the head
// is what a setter pastes into a search, the tail is what distinguishes two
// rebuilds of the same problem that would otherwise share a head. Real
// package hashes are 64 hex characters (contracts' AttachRevisionRequest),
// always long enough to truncate; the length guard just keeps this safe for
// anything shorter without producing a negative-length slice.
const HASH_HEAD = 8;
const HASH_TAIL = 4;
function truncateHash(hash: string): string {
  if (hash.length <= HASH_HEAD + HASH_TAIL) return hash;
  return `${hash.slice(0, HASH_HEAD)}…${hash.slice(-HASH_TAIL)}`;
}

// app.css's `.badge` colour+glyph system, reused here across a different
// domain than a verdict: `published` maps to the same "good" token as `AC`
// (it is the only row answering "which one is actually grading"); `draft`
// and `archived` both map to the neutral `pend` token. See app.css's header
// comment.
function stateToken(state: Revision['state']): string {
  return state === 'published' ? 'ac' : 'pend';
}

/**
 * `/problems/:code/revisions`: every revision — draft, published and
 * archived alike (the API's `listRevisions` deliberately does not filter
 * these the way `GET /problems/:code` filters to the published one) — a
 * text input plus button to attach an already-uploaded package as a new
 * draft revision, and a per-revision Publish button for anything not
 * already published.
 *
 * Both actions surface the server's error `code` verbatim on failure
 * (`package_not_found`, `package_invalid`, `package_path_collision`,
 * `revision_not_found`, `problem_forbidden`, …) rather than a paraphrase —
 * a setter pasting a bad package hash needs to see exactly that code
 * (task-12 brief).
 */
export function ProblemRevisionsPage(props: { code: string }) {
  const { code } = props;
  const client = useQueryClient();

  const query = useQuery({
    queryKey: ['problem-revisions', code],
    queryFn: async () => {
      const { data, error } = await api.GET('/problems/{code}/revisions', { params: { path: { code } } });
      if (error || !data) {
        throw new Error('Could not load revisions.');
      }
      return data;
    },
    retry: false,
  });

  const [packageHash, setPackageHash] = useState('');
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  // The version currently mid-publish, if any — used only to disable that
  // one row's button while the request is in flight, not to gate the whole
  // page.
  const [publishingVersion, setPublishingVersion] = useState<number | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  async function handleAttach(): Promise<void> {
    setAttachBusy(true);
    setAttachError(null);
    try {
      // Same openapi-fetch error shape as everywhere else in this app: an
      // HTTP error resolves to `{ error }` (the branch that shows `code`
      // below); a network-level failure rethrows into the `catch`.
      const { error } = await api.POST('/problems/{code}/revisions', {
        params: { path: { code } },
        body: { packageHash },
      });
      if (error) {
        setAttachError(error.code);
        return;
      }
      setPackageHash('');
      await client.invalidateQueries({ queryKey: ['problem-revisions', code] });
    } catch {
      setAttachError('Could not reach the server. Check your connection and try again.');
    } finally {
      setAttachBusy(false);
    }
  }

  async function handlePublish(version: number): Promise<void> {
    setPublishingVersion(version);
    setPublishError(null);
    try {
      const { error } = await api.POST('/problems/{code}/revisions/{version}/publish', {
        params: { path: { code, version } },
      });
      if (error) {
        setPublishError(error.code);
        return;
      }
      await client.invalidateQueries({ queryKey: ['problem-revisions', code] });
    } catch {
      setPublishError('Could not reach the server. Check your connection and try again.');
    } finally {
      setPublishingVersion(null);
    }
  }

  const revisions: Revision[] = query.data ?? [];

  return (
    <section>
      <h1>Revisions — {code}</h1>

      <div>
        <label htmlFor="package-hash">Package hash</label>
        <input id="package-hash" value={packageHash} onChange={(e) => setPackageHash(e.target.value)} />
        <button type="button" onClick={() => void handleAttach()} disabled={attachBusy || packageHash === ''}>
          Attach
        </button>
        {attachError ? <p role="alert">{attachError}</p> : null}
      </div>

      {publishError ? <p role="alert">{publishError}</p> : null}

      {query.isLoading ? <p>Loading…</p> : null}
      {query.isError ? <p role="alert">Could not load revisions.</p> : null}

      {revisions.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>State</th>
              <th>Package</th>
              <th className="num">Time</th>
              <th className="num">Mem</th>
              <th className="num">Tests</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {revisions.map((r) => (
              <tr key={r.id}>
                <td>{r.version}</td>
                <td>
                  <span className={`badge ${stateToken(r.state)}`}>{r.state}</span>
                </td>
                {/* `title` carries the full 64-character hash — truncation
                    is a display choice, not a loss of the value someone
                    might need to paste in full. */}
                <td title={r.packageHash}>{truncateHash(r.packageHash)}</td>
                {/* Two right-aligned numeric columns, not one free-text
                    cell — same fix as the problem list's limits columns
                    (problems.tsx), reusing its `formatMemoryMb` rather than
                    a second copy of "how do we render a memory limit". */}
                <td className="num">{r.timeMs} ms</td>
                <td className="num">{formatMemoryMb(r.memoryKb)}</td>
                <td className="num">{r.testCount}</td>
                <td>{r.notes ?? '—'}</td>
                <td>
                  {/* Publish is only ever offered for a revision that is
                      NOT already published — publishing the current
                      revision again is a legal no-op server-side, but
                      offering the button here would invite exactly that
                      confusing no-op click (task-12 brief, "publish is not
                      offered for the already-published revision"). */}
                  {r.state !== 'published' ? (
                    <button
                      type="button"
                      onClick={() => void handlePublish(r.version)}
                      disabled={publishingVersion === r.version}
                    >
                      Publish
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !query.isLoading && !query.isError ? (
        <p>No revisions yet.</p>
      ) : null}
    </section>
  );
}

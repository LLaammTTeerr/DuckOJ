import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { formatMemoryMb } from './problems.js';
import { useT } from '../i18n/index.js';

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
  const t = useT();
  const { code } = props;
  const client = useQueryClient();

  const query = useQuery({
    queryKey: ['problem-revisions', code],
    queryFn: async () => {
      const { data, error } = await api.GET('/problems/{code}/revisions', { params: { path: { code } } });
      if (error || !data) {
        throw new Error(t('revisions.loadError'));
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

  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadHash, setUploadHash] = useState('');
  const [archive, setArchive] = useState<File | null>(null);

  /**
   * Browser upload of a built archive (Phase 5f). The hash is pasted from
   * `package:build`'s output rather than computed here: the package hash is
   * over the *unpacked file digests* (tar+zstd), which a browser cannot
   * cheaply recompute — and the server recomputes and verifies it anyway,
   * so a typo is a 422, never a wrong package. On success the attach field
   * is prefilled, making upload → attach two clicks.
   */
  async function handleUpload(): Promise<void> {
    if (!archive) return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      const { error } = await api.POST('/packages', {
        params: { query: { hash: uploadHash } },
        body: await archive.arrayBuffer(),
        bodySerializer: (body: ArrayBuffer) => body,
        headers: { 'content-type': 'application/octet-stream' },
      } as never);
      if (error) {
        setUploadError((error as { code?: string }).code ?? t('revisions.uploadFailed'));
        return;
      }
      setPackageHash(uploadHash);
      setUploadHash('');
      setArchive(null);
    } catch {
      setUploadError(t('common.networkError'));
    } finally {
      setUploadBusy(false);
    }
  }

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
      setAttachError(t('common.networkError'));
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
      setPublishError(t('common.networkError'));
    } finally {
      setPublishingVersion(null);
    }
  }

  const revisions: Revision[] = query.data ?? [];

  return (
    <section>
      <h1>{t('revisions.title', { code })}</h1>

      <div>
        <label htmlFor="package-archive">{t('revisions.uploadPackage')}</label>
        <input
          id="package-archive"
          type="file"
          accept=".zst,.tar.zst"
          onChange={(e) => setArchive(e.target.files?.[0] ?? null)}
        />
        <label htmlFor="upload-hash">{t('revisions.uploadHash')}</label>
        <input id="upload-hash" value={uploadHash} onChange={(e) => setUploadHash(e.target.value)} />
        <button
          type="button"
          onClick={() => void handleUpload()}
          disabled={uploadBusy || archive === null || uploadHash === ''}
        >
          {t('revisions.upload')}
        </button>
        {uploadError ? <p role="alert">{uploadError}</p> : null}
      </div>

      <div>
        <label htmlFor="package-hash">{t('revisions.packageHash')}</label>
        <input id="package-hash" value={packageHash} onChange={(e) => setPackageHash(e.target.value)} />
        <button type="button" onClick={() => void handleAttach()} disabled={attachBusy || packageHash === ''}>
          {t('revisions.attach')}
        </button>
        {attachError ? <p role="alert">{attachError}</p> : null}
      </div>

      {publishError ? <p role="alert">{publishError}</p> : null}

      {query.isLoading ? <p>{t('common.loading')}</p> : null}
      {query.isError ? <p role="alert">{t('revisions.loadError')}</p> : null}

      {revisions.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('revisions.colVersion')}</th>
              <th>{t('revisions.colState')}</th>
              <th>{t('revisions.colPackage')}</th>
              <th className="num">{t('problems.colTime')}</th>
              <th className="num">{t('problems.colMem')}</th>
              <th className="num">{t('problems.colTests')}</th>
              <th>{t('revisions.colNotes')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {revisions.map((r) => (
              <tr key={r.id}>
                <td>{r.version}</td>
                <td>
                  <span className={`badge ${stateToken(r.state)}`}>{t(`revState.${r.state}`)}</span>
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
                      {t('revisions.publish')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !query.isLoading && !query.isError ? (
        <p>{t('revisions.empty')}</p>
      ) : null}
    </section>
  );
}

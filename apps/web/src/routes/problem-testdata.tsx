import { useId, useState } from 'react';
import { api } from '../api.js';
import { useT } from '../i18n/index.js';
import { LazyCodeEditor } from '../editor/lazy.js';
import {
  CHECKER_FILE_NAME,
  pairByStem,
  planPackage,
  type CaseDraft,
  type CheckerDraft,
  type UnpairedFile,
} from '../testdata/pairing.js';

/**
 * The largest one test file may be, client-side (D87).
 *
 * A megabyte is already an enormous single test for a provincial problem
 * (`content/README.md` puts the whole demo set at 1.2 MB across sixty
 * files), and the reason to refuse it HERE rather than let the server do it
 * is that everything on this screen is held in memory as a string until the
 * revision is created: a setter who selects a 400 MB file should be told so
 * while there is still a form to fix, not after the browser tab dies.
 */
export const MAX_TEST_FILE_BYTES = 1_048_576;

const DEFAULT_TIME_MS = 1000;
const DEFAULT_MEMORY_KB = 262_144;

let nextCaseId = 0;
function emptyCase(): CaseDraft {
  nextCaseId += 1;
  return { id: `c${String(nextCaseId)}`, input: '', answer: '', points: 0, group: 0, sample: false, explanation: '' };
}

/** `File` -> its text, refusing anything past the per-file ceiling. */
async function readFileText(file: File): Promise<string> {
  if (file.size > MAX_TEST_FILE_BYTES) {
    throw new Error(file.name);
  }
  return file.text();
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'uploading'; done: number; total: number }
  | { kind: 'building' };

/**
 * "Dữ liệu chấm" — the test-data tab of the problem edit screen (D87).
 *
 * Everything here is held CLIENT-SIDE until "Tạo phiên bản" is pressed.
 * Nothing is uploaded as you type, nothing is uploaded as you select files,
 * and abandoning the tab costs the server nothing — which is what makes it
 * safe to let a setter assemble sixty test cases in a browser at all. The
 * one round of uploads happens at the end, file by file, through the draft
 * endpoints, and the server then builds exactly the same package
 * `package:build` would have built from the same directory.
 *
 * No zips, in either direction. The 7a ruling refuses server-side archive
 * ingestion and this screen does not smuggle it back in through a file
 * picker: a bulk add is many individual files, paired here by stem.
 */
export function ProblemTestDataTab(props: { code: string }) {
  const t = useT();
  const { code } = props;
  const uid = useId();

  const [timeMs, setTimeMs] = useState(String(DEFAULT_TIME_MS));
  const [memoryKb, setMemoryKb] = useState(String(DEFAULT_MEMORY_KB));
  const [checker, setChecker] = useState<CheckerDraft>({ kind: 'standard', source: '', language: 'cpp17' });
  const [cases, setCases] = useState<CaseDraft[]>([]);
  const [unpaired, setUnpaired] = useState<UnpairedFile[]>([]);
  const [oversized, setOversized] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [publish, setPublish] = useState(false);

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<{ version: number; published: boolean } | null>(null);
  const [loaded, setLoaded] = useState<number | null>(null);

  const busy = phase.kind !== 'idle';
  const totalPoints = cases.reduce((sum, c) => sum + (c.sample ? 0 : c.points), 0);

  function patchCase(id: string, patch: Partial<CaseDraft>): void {
    setCases((current) => current.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  /**
   * Bulk add: many `.in`/`.out`/`.a` files at once, paired by stem here in
   * the browser. Files too large are named rather than silently skipped, and
   * so are halves whose partner is missing — a test set that quietly lost a
   * case is the exact failure this screen exists to prevent.
   */
  async function handleBulk(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return;
    setError(null);
    const tooBig: string[] = [];
    const read: { name: string; text: string }[] = [];
    for (const file of Array.from(list)) {
      try {
        read.push({ name: file.name, text: await readFileText(file) });
      } catch {
        tooBig.push(file.name);
      }
    }
    setOversized(tooBig);
    const { paired, unpaired: leftovers } = pairByStem(read);
    setUnpaired(leftovers);
    setCases((current) => [
      ...current,
      ...paired.map((p) => ({ ...emptyCase(), input: p.input, answer: p.answer })),
    ]);
  }

  async function handleOne(id: string, field: 'input' | 'answer', file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      patchCase(id, { [field]: await readFileText(file) });
      setOversized([]);
    } catch {
      setOversized([file.name]);
    }
  }

  /**
   * Load an existing revision's test data into this table (D88).
   *
   * The server opens a draft pre-filled from the revision and this reads the
   * files back out of it one at a time — then DISCARDS it. The draft was
   * never anything but a way to read: everything on this screen lives in
   * memory until "Tạo phiên bản", and the build path opens a draft of its
   * own, so keeping this one would leave a second, diverging copy of the
   * same test set on the server for 24 hours.
   *
   * The PUBLISHED revision, not the newest one: "load what this problem
   * currently grades against" is the question a setter is asking. A problem
   * with no published revision falls back to its highest version, which is
   * the only other thing the sentence could mean.
   */
  async function handleLoad(): Promise<void> {
    setError(null);
    setBuilt(null);
    setLoaded(null);
    setOversized([]);
    setUnpaired([]);

    let draftId: string | null = null;
    try {
      setPhase({ kind: 'loading' });
      const list = await api.GET('/problems/{code}/revisions', { params: { path: { code } } });
      if (list.error || !list.data) {
        setError(list.error?.detail ?? t('testData.loadFailed'));
        return;
      }
      const revisions = list.data;
      const target =
        revisions.find((r) => r.state === 'published') ??
        [...revisions].sort((a, b) => b.version - a.version)[0];
      if (target === undefined) {
        setError(t('testData.noRevision'));
        return;
      }

      const opened = await api.POST('/problems/{code}/drafts/from-revision/{version}', {
        params: { path: { code, version: target.version } },
      });
      if (opened.error || !opened.data) {
        setError(opened.error?.detail ?? t('testData.loadFailed'));
        return;
      }
      draftId = opened.data.draftId;
      const prefill = opened.data.prefill;

      const names = prefill.cases.flatMap((c) => [c.input, c.answer]);
      if (prefill.checker.kind === 'source' && prefill.checker.path !== undefined) {
        names.push(prefill.checker.path);
      }
      const texts = new Map<string, string>();
      const tooBig: string[] = [];
      for (const name of names) {
        const file = await api.GET('/problems/{code}/drafts/{draftId}/files/{name}', {
          params: { path: { code, draftId, name } },
          parseAs: 'text',
        });
        if (file.error || file.data === undefined) {
          setError(`${name}: ${file.error?.detail ?? t('testData.loadFailed')}`);
          return;
        }
        const text = String(file.data);
        // The same ceiling a selected file gets, and for the same reason:
        // every byte here becomes a `<textarea>`'s value. A CLI-built test
        // set with a megabyte case cannot be edited in a browser, and being
        // told that is far better than a tab that dies loading it.
        if (new TextEncoder().encode(text).length > MAX_TEST_FILE_BYTES) tooBig.push(name);
        texts.set(name, text);
      }
      if (tooBig.length > 0) {
        setOversized(tooBig);
        setError(t('testData.loadTooLarge'));
        return;
      }

      setTimeMs(String(prefill.timeMs));
      setMemoryKb(String(prefill.memoryKb));
      setChecker({
        kind: prefill.checker.kind,
        source: prefill.checker.path === undefined ? '' : (texts.get(prefill.checker.path) ?? ''),
        language: prefill.checker.language ?? 'cpp17',
      });
      // REPLACES the table rather than appending to it: this is "show me
      // what is published", not "add it to what I am writing", and merging
      // two test sets by accident is not something a setter can undo here.
      setCases(
        prefill.cases.map((c) => ({
          ...emptyCase(),
          input: texts.get(c.input) ?? '',
          answer: texts.get(c.answer) ?? '',
          points: c.points,
          group: c.group,
          sample: c.sample,
          explanation: c.explanation,
        })),
      );
      setLoaded(target.version);
    } catch {
      setError(t('common.networkError'));
    } finally {
      if (draftId !== null) {
        await api
          .DELETE('/problems/{code}/drafts/{draftId}', { params: { path: { code, draftId } } })
          .catch(() => undefined);
      }
      setPhase({ kind: 'idle' });
    }
  }

  /**
   * Create the revision: open a draft, PUT every planned file into it, then
   * ask the server to build.
   *
   * The draft is discarded on a failed BUILD as well as on a failed upload —
   * not because the server needs it (a refused build deliberately leaves the
   * draft intact so a CLI user can fix one file and retry) but because this
   * screen holds every byte in memory and will simply send them all again.
   * Leaving 500 files on the server for 24 hours to be re-sent anyway is
   * cost with no benefit.
   */
  async function handleCreate(): Promise<void> {
    setError(null);
    setBuilt(null);
    const plan = planPackage({
      name: code,
      timeMs: Number(timeMs),
      memoryKb: Number(memoryKb),
      checker,
      cases,
    });

    let draftId: string | null = null;
    try {
      setPhase({ kind: 'uploading', done: 0, total: plan.files.length });
      const opened = await api.POST('/problems/{code}/drafts', { params: { path: { code } } });
      if (opened.error || !opened.data) {
        setError(opened.error?.code ?? t('testData.createFailed'));
        return;
      }
      draftId = opened.data.draftId;

      for (const [index, file] of plan.files.entries()) {
        const put = await api.PUT('/problems/{code}/drafts/{draftId}/files/{name}', {
          params: { path: { code, draftId, name: file.name } },
          body: new TextEncoder().encode(file.text),
          bodySerializer: (body: Uint8Array) => body,
          headers: { 'content-type': 'application/octet-stream' },
        } as never);
        if (put.error) {
          setError(`${file.name}: ${(put.error as { code?: string }).code ?? ''}`);
          return;
        }
        setPhase({ kind: 'uploading', done: index + 1, total: plan.files.length });
      }

      setPhase({ kind: 'building' });
      const build = await api.POST('/problems/{code}/drafts/{draftId}/build', {
        params: { path: { code, draftId } },
        body: { publish, ...(notes.trim() === '' ? {} : { notes }) },
      });
      if (build.error || !build.data) {
        // `detail` verbatim, not a paraphrase: on a refusal it is
        // `buildPackage`'s own sentence, which NAMES the files that are
        // missing or the manifest field that is wrong. That is the whole
        // value of the message (D18's precedent for server wording).
        setError(build.error?.detail ?? build.error?.code ?? t('testData.buildFailed'));
        return;
      }
      setBuilt({ version: build.data.version, published: build.data.published });
      draftId = null;
    } catch {
      setError(t('common.networkError'));
    } finally {
      if (draftId !== null) {
        await api
          .DELETE('/problems/{code}/drafts/{draftId}', { params: { path: { code, draftId } } })
          .catch(() => undefined);
      }
      setPhase({ kind: 'idle' });
    }
  }

  return (
    <section>
      <h2>{t('testData.title')}</h2>
      <p>{t('testData.intro')}</p>

      <label htmlFor={`${uid}-time`}>{t('testData.timeMs')}</label>
      <input
        id={`${uid}-time`}
        type="number"
        min={1}
        value={timeMs}
        onChange={(e) => setTimeMs(e.target.value)}
      />

      <label htmlFor={`${uid}-memory`}>{t('testData.memoryKb')}</label>
      <input
        id={`${uid}-memory`}
        type="number"
        min={1}
        value={memoryKb}
        onChange={(e) => setMemoryKb(e.target.value)}
      />

      <label htmlFor={`${uid}-checker`}>{t('testData.checker')}</label>
      <select
        id={`${uid}-checker`}
        value={checker.kind}
        onChange={(e) => setChecker((c) => ({ ...c, kind: e.target.value as CheckerDraft['kind'] }))}
      >
        <option value="standard">{t('testData.checkerStandard')}</option>
        <option value="source">{t('testData.checkerSource')}</option>
      </select>

      {/* D40: a source checker IS a testlib checker, rendered `bridged` for
          the judge. The editor is the same CodeMirror the submit box uses
          (D84), behind the same lazy boundary, so this tab costs a reader of
          the problem list nothing. */}
      {checker.kind === 'source' ? (
        <div>
          <p>{t('testData.checkerHint', { file: CHECKER_FILE_NAME })}</p>
          <LazyCodeEditor
            value={checker.source}
            onChange={(source) => setChecker((c) => ({ ...c, source }))}
            onSubmit={() => undefined}
            languageKey={checker.language}
            ariaLabel={t('testData.checkerSourceLabel')}
            fontSize={13}
            id={`${uid}-checker-source`}
          />
        </div>
      ) : null}

      <h3>{t('testData.cases')}</h3>
      <p>
        {t('testData.summary', { n: cases.length, points: totalPoints })}
      </p>

      <label htmlFor={`${uid}-bulk`}>{t('testData.bulkAdd')}</label>
      <input
        id={`${uid}-bulk`}
        type="file"
        multiple
        accept=".in,.out,.a"
        onChange={(e) => void handleBulk(e.target.files)}
      />
      <p>{t('testData.bulkHint')}</p>

      {/* D88: the round trip. Deliberately beside the bulk add rather than
          at the top — loading a published set is one more way to fill this
          table, not a mode the screen is in. */}
      <p>
        <button type="button" onClick={() => void handleLoad()} disabled={busy}>
          {t('testData.loadFromRevision')}
        </button>{' '}
        {t('testData.loadHint')}
      </p>

      {oversized.length > 0 ? (
        <p role="alert">{t('testData.tooLarge', { names: oversized.join(', ') })}</p>
      ) : null}
      {unpaired.length > 0 ? (
        <ul data-testid="unpaired">
          {unpaired.map((u) => (
            <li key={`${u.name}-${u.reason}`} role="alert">
              {t(`testData.unpaired.${u.reason}`, { name: u.name })}
            </li>
          ))}
        </ul>
      ) : null}

      <button type="button" onClick={() => setCases((c) => [...c, emptyCase()])} disabled={busy}>
        {t('testData.addCase')}
      </button>

      {cases.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('testData.colNo')}</th>
              <th>{t('testData.colInput')}</th>
              <th>{t('testData.colAnswer')}</th>
              <th className="num">{t('testData.colPoints')}</th>
              <th className="num">{t('testData.colGroup')}</th>
              <th>{t('testData.colSample')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cases.map((c, i) => (
              <tr key={c.id}>
                <td>{i + 1}</td>
                <td>
                  <label htmlFor={`${uid}-in-${c.id}`}>{t('testData.colInput')}</label>
                  <textarea
                    id={`${uid}-in-${c.id}`}
                    value={c.input}
                    onChange={(e) => patchCase(c.id, { input: e.target.value })}
                  />
                  <input
                    type="file"
                    aria-label={t('testData.uploadInputFor', { n: i + 1 })}
                    onChange={(e) => void handleOne(c.id, 'input', e.target.files?.[0])}
                  />
                </td>
                <td>
                  <label htmlFor={`${uid}-out-${c.id}`}>{t('testData.colAnswer')}</label>
                  <textarea
                    id={`${uid}-out-${c.id}`}
                    value={c.answer}
                    onChange={(e) => patchCase(c.id, { answer: e.target.value })}
                  />
                  <input
                    type="file"
                    aria-label={t('testData.uploadAnswerFor', { n: i + 1 })}
                    onChange={(e) => void handleOne(c.id, 'answer', e.target.files?.[0])}
                  />
                </td>
                <td className="num">
                  {/* A sample is worth nothing by definition, so the points
                      box is disabled rather than merely ignored — a number
                      typed there and then silently dropped would be worse
                      than not offering it. */}
                  <input
                    type="number"
                    min={0}
                    aria-label={t('testData.pointsFor', { n: i + 1 })}
                    value={c.sample ? 0 : c.points}
                    disabled={c.sample}
                    onChange={(e) => patchCase(c.id, { points: Number(e.target.value) })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    aria-label={t('testData.groupFor', { n: i + 1 })}
                    value={c.sample ? 0 : c.group}
                    disabled={c.sample}
                    onChange={(e) => patchCase(c.id, { group: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t('testData.sampleFor', { n: i + 1 })}
                    checked={c.sample}
                    onChange={(e) => patchCase(c.id, { sample: e.target.checked })}
                  />
                  {/* D94's explanation, offered only once the case IS a
                      sample: the manifest refuses one on a graded case, and
                      an input that silently drops what was typed into it is
                      the same mistake the disabled points box avoids. What
                      is typed here is Markdown, rendered under the sample on
                      the problem page. */}
                  {c.sample ? (
                    <input
                      aria-label={t('testData.explanationFor', { n: i + 1 })}
                      placeholder={t('testData.explanation')}
                      value={c.explanation}
                      onChange={(e) => patchCase(c.id, { explanation: e.target.value })}
                    />
                  ) : null}
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => setCases((current) => current.filter((x) => x.id !== c.id))}
                    disabled={busy}
                  >
                    {t('testData.removeCase')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{t('testData.noCases')}</p>
      )}

      <label htmlFor={`${uid}-notes`}>{t('testData.notes')}</label>
      <input id={`${uid}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} />

      <label htmlFor={`${uid}-publish`}>
        <input
          id={`${uid}-publish`}
          type="checkbox"
          checked={publish}
          onChange={(e) => setPublish(e.target.checked)}
        />{' '}
        {t('testData.publishToo')}
      </label>

      <button type="button" onClick={() => void handleCreate()} disabled={busy || cases.length === 0}>
        {t('testData.create')}
      </button>

      {phase.kind === 'loading' ? <p role="status">{t('testData.loading')}</p> : null}
      {loaded !== null ? <p role="status">{t('testData.loaded', { version: loaded })}</p> : null}
      {phase.kind === 'uploading' ? (
        <p role="status">{t('testData.uploading', { done: phase.done, total: phase.total })}</p>
      ) : null}
      {phase.kind === 'building' ? <p role="status">{t('testData.building')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {built ? (
        <p role="status">
          {t(built.published ? 'testData.builtPublished' : 'testData.built', { version: built.version })}{' '}
          <a href={`/problems/${code}/revisions`}>{t('testData.toRevisions')}</a>
        </p>
      ) : null}
    </section>
  );
}

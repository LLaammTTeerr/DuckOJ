/**
 * `/contests/$key/edit` — the screen `PATCH /contests/{key}` never had.
 *
 * Prefilled from `GET /contests/{key}`, and it sends only what the form can
 * actually express, so a field this page does not show is a field the request
 * leaves alone (the API reads an absent key as "keep"). `key` and the
 * contest's org shares are not editable here at all — see the request
 * schema's own note.
 *
 * Times round-trip through `datetime-local`, which speaks the browser's own
 * zone and no other: the API stores instants, so the value is parsed back to
 * one on submit. `toLocalInput` below is the inverse of `contest-new.tsx`'s
 * `new Date(value).toISOString()`, and getting it wrong is how a contest
 * starts seven hours early.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { useT } from '../i18n/index.js';

type ContestDetail = paths['/contests/{key}']['get']['responses'][200]['content']['application/json'];
type Visibility = ContestDetail['visibility'];

/** The four formats the registry ships; the API refuses anything else. */
const FORMATS = ['default', 'icpc', 'ioi16', 'legacy_ioi'] as const;

interface ProblemRow {
  code: string;
  points: string;
  partial: boolean;
  /**
   * The setter's label, carried through unedited.
   *
   * `problems` is the one all-or-nothing field in the PATCH body — the API
   * replaces the whole list — so anything this form drops is a thing the save
   * destroys. A contest labelled `A`, `B`, `C` (which is what an API client or
   * a seeded contest looks like) would come back `1`, `2`, `3`. Worse, the
   * server's "is this actually a change?" check compares labels too, so a
   * dropped label turns an untouched save of a RUNNING contest into a 409
   * `contest_started` — the no-op case the API deliberately allows.
   *
   * `undefined` for a row added here: the API then defaults it to the
   * 1-based position, which is the right answer for a brand-new row and not
   * something this form should have to know.
   */
  label?: string;
}

/**
 * An ISO instant as `datetime-local` wants it: the reader's OWN wall clock,
 * `YYYY-MM-DDTHH:mm`, with no zone suffix. `toISOString().slice(0, 16)` would
 * be UTC's wall clock instead, which silently shifts every time shown to
 * anyone not on UTC — and then saves the shifted value back.
 */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function ContestEditPage({ contestKey }: { contestKey: string }) {
  const t = useT();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['contest', contestKey],
    queryFn: async (): Promise<ContestDetail> => {
      const { data, error } = await api.GET('/contests/{key}', {
        params: { path: { key: contestKey } },
      });
      if (error) throw new Error(error.detail ?? t('contest.notFound'));
      return data;
    },
    retry: false,
  });

  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [format, setFormat] = useState<string>('icpc');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [rows, setRows] = useState<ProblemRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Which contest the form was seeded FROM — a key, not a boolean. The
  // router keys this component by `$key` as well (both, for the same reason
  // `problem-edit.tsx` documents): a form whose state survives a change of
  // key carries contest A's values into a save against contest B.
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  useEffect(() => {
    const contest = query.data;
    if (!contest || seededFrom === contest.key) return;
    setName(contest.name);
    setStart(toLocalInput(contest.startTime));
    setEnd(toLocalInput(contest.endTime));
    setFormat(contest.format);
    setVisibility(contest.visibility);
    setRows(
      contest.problems.map((problem) => ({
        code: problem.code,
        points: String(problem.points),
        partial: problem.partial,
        label: problem.label,
      })),
    );
    setSeededFrom(contest.key);
  }, [seededFrom, query.data]);

  function setRow(index: number, patch: Partial<ProblemRow>): void {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function save(): Promise<void> {
    const problems = rows.filter((row) => row.code.trim() !== '');
    for (const row of problems) {
      if (Number.isNaN(Number(row.points)) || Number(row.points) < 0) {
        setError(t('contestNew.badPoints', { code: row.code }));
        return;
      }
    }
    if (start === '' || end === '') {
      setError(t('contestNew.datesRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await api.PATCH('/contests/{key}', {
        params: { path: { key: contestKey } },
        body: {
          name,
          startTime: new Date(start).toISOString(),
          endTime: new Date(end).toISOString(),
          format,
          visibility,
          problems: problems.map((row) => ({
            code: row.code.trim(),
            points: Number(row.points),
            partial: row.partial,
            // Omitted, never sent as `undefined`: `exactOptionalPropertyTypes`
            // separates the two, and a present-but-undefined key would travel
            // into the request body.
            ...(row.label === undefined ? {} : { label: row.label }),
          })),
        },
      });
      if (err) {
        setError(err.detail ?? err.code);
        return;
      }
      await navigate({ to: '/contests/$key', params: { key: contestKey } });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  if (query.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return null;

  return (
    <section className="panel">
      <h1>{t('contestEdit.title', { key: query.data.key })}</h1>
      <p>
        <label>
          {t('common.name')}{' '}
          <input
            aria-label={t('common.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </p>
      <p>
        <label>
          {t('contestNew.starts')}{' '}
          <input
            type="datetime-local"
            aria-label={t('contestNew.starts')}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>{' '}
        <label>
          {t('contestNew.ends')}{' '}
          <input
            type="datetime-local"
            aria-label={t('contestNew.ends')}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </p>
      <p>
        <label>
          {t('contestNew.format')}{' '}
          {/* The four format KEYS are the registry's own vocabulary and go
              on the wire verbatim — an identifier, not a label. */}
          <select
            aria-label={t('contestNew.format')}
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          {t('common.visibility')}{' '}
          {/* Here the VALUE is the API's enum and the LABEL is prose, so
              only the label is translated. */}
          <select
            aria-label={t('common.visibility')}
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
          >
            <option value="private">{t('visibility.private')}</option>
            <option value="org">{t('visibility.org')}</option>
            <option value="public">{t('visibility.public')}</option>
          </select>
        </label>
      </p>

      <h2>{t('contestNew.problems')}</h2>
      <table>
        <thead>
          <tr>
            <th>{t('contestNew.colCode')}</th>
            <th className="num">{t('contestNew.colPoints')}</th>
            <th>{t('contestNew.colPartial')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>
                <input
                  aria-label={t('contestNew.rowCode', { n: index + 1 })}
                  value={row.code}
                  onChange={(e) => setRow(index, { code: e.target.value })}
                />
              </td>
              <td className="num">
                <input
                  aria-label={t('contestNew.rowPoints', { n: index + 1 })}
                  value={row.points}
                  onChange={(e) => setRow(index, { points: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={t('contestNew.rowPartial', { n: index + 1 })}
                  checked={row.partial}
                  onChange={(e) => setRow(index, { partial: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, { code: '', points: '100', partial: true }])}
        >
          {t('contestNew.addProblem')}
        </button>
      </p>

      {error ? <p role="alert">{error}</p> : null}
      <p>
        <button type="button" disabled={busy || name === ''} onClick={() => void save()}>
          {t('contestEdit.save')}
        </button>{' '}
        <Link to="/contests/$key" params={{ key: contestKey }}>
          {t('common.cancel')}
        </Link>
      </p>
    </section>
  );
}

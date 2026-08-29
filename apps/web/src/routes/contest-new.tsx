/**
 * `/contests/new` — the screen `POST /contests` never had (Phase 5f: the
 * contest existed over HTTP since 4c and could not be created from the
 * browser at all).
 *
 * Times are entered in the setter's own timezone via `datetime-local` and
 * sent as ISO instants — the API stores instants, and a setter thinking in
 * UTC while their browser thinks in ICT is how a contest starts seven
 * hours early.
 */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { api } from '../api.js';
import { useT } from '../i18n/index.js';

interface ProblemRow {
  code: string;
  points: string;
  partial: boolean;
}

/** The four formats the registry ships; the API refuses anything else. */
const FORMATS = ['default', 'icpc', 'ioi16', 'legacy_ioi'] as const;

export function ContestNewPage() {
  const t = useT();
  const navigate = useNavigate();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [format, setFormat] = useState<string>('icpc');
  const [visibility, setVisibility] = useState<'public' | 'org' | 'private'>('private');
  const [rows, setRows] = useState<ProblemRow[]>([{ code: '', points: '100', partial: true }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setRow(index: number, patch: Partial<ProblemRow>): void {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function create(): Promise<void> {
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
    try {
      const { data, error: err } = await api.POST('/contests', {
        body: {
          key,
          name,
          // `datetime-local` yields a zoneless string; `new Date(...)` reads
          // it in the browser's zone, and toISOString sends the instant.
          startTime: new Date(start).toISOString(),
          endTime: new Date(end).toISOString(),
          format,
          visibility,
          problems: problems.map((row) => ({
            code: row.code.trim(),
            points: Number(row.points),
            partial: row.partial,
          })),
        },
      });
      if (err) {
        setError(err.detail ?? t('contestNew.createError'));
        return;
      }
      await navigate({ to: '/contests/$key', params: { key: data.key } });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h1>{t('contestNew.title')}</h1>
      <p>
        <label>
          {t('contestNew.key')}{' '}
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="spring-open" />
        </label>
      </p>
      <p>
        <label>
          {t('common.name')} <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          {t('contestNew.starts')}{' '}
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>{' '}
        <label>
          {t('contestNew.ends')}{' '}
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          {t('contestNew.format')}{' '}
          {/* The four format KEYS are the registry's own vocabulary and go
              on the wire verbatim — an identifier, not a label. */}
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
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
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
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
        <button type="button" disabled={busy || key === '' || name === ''} onClick={() => void create()}>
          {t('contestNew.create')}
        </button>{' '}
        <Link to="/contests">{t('common.cancel')}</Link>
      </p>
    </section>
  );
}

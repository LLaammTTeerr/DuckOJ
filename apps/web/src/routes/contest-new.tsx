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

interface ProblemRow {
  code: string;
  points: string;
  partial: boolean;
}

/** The four formats the registry ships; the API refuses anything else. */
const FORMATS = ['default', 'icpc', 'ioi16', 'legacy_ioi'] as const;

export function ContestNewPage() {
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
        setError(`Problem ${row.code}: points must be a non-negative number.`);
        return;
      }
    }
    if (start === '' || end === '') {
      setError('Start and end are required.');
      return;
    }
    setBusy(true);
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
    setBusy(false);
    if (err) {
      setError(err.detail ?? 'Could not create the contest.');
      return;
    }
    await navigate({ to: '/contests/$key', params: { key: data.key } });
  }

  return (
    <section className="panel">
      <h1>New contest</h1>
      <p>
        <label>
          Key <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="spring-open" />
        </label>
      </p>
      <p>
        <label>
          Name <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Starts{' '}
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>{' '}
        <label>
          Ends <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Format{' '}
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Visibility{' '}
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
          >
            <option value="private">private</option>
            <option value="org">org</option>
            <option value="public">public</option>
          </select>
        </label>
      </p>

      <h2>Problems</h2>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th className="num">Points</th>
            <th>Partial</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>
                <input
                  aria-label={`Problem ${String(index + 1)} code`}
                  value={row.code}
                  onChange={(e) => setRow(index, { code: e.target.value })}
                />
              </td>
              <td className="num">
                <input
                  aria-label={`Problem ${String(index + 1)} points`}
                  value={row.points}
                  onChange={(e) => setRow(index, { points: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Problem ${String(index + 1)} partial credit`}
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
          Add problem
        </button>
      </p>

      {error ? <p role="alert">{error}</p> : null}
      <p>
        <button type="button" disabled={busy || key === '' || name === ''} onClick={() => void create()}>
          Create contest
        </button>{' '}
        <Link to="/contests">Cancel</Link>
      </p>
    </section>
  );
}

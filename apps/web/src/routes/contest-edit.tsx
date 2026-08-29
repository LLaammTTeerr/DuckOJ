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

type ContestDetail = paths['/contests/{key}']['get']['responses'][200]['content']['application/json'];
type Visibility = ContestDetail['visibility'];

/** The four formats the registry ships; the API refuses anything else. */
const FORMATS = ['default', 'icpc', 'ioi16', 'legacy_ioi'] as const;

interface ProblemRow {
  code: string;
  points: string;
  partial: boolean;
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
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['contest', contestKey],
    queryFn: async (): Promise<ContestDetail> => {
      const { data, error } = await api.GET('/contests/{key}', {
        params: { path: { key: contestKey } },
      });
      if (error) throw new Error(error.detail ?? 'No such contest.');
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
        setError(`Problem ${row.code}: points must be a non-negative number.`);
        return;
      }
    }
    if (start === '' || end === '') {
      setError('Start and end are required.');
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
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return null;

  return (
    <section className="panel">
      <h1>Edit {query.data.key}</h1>
      <p>
        <label>
          Name <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Starts{' '}
          <input
            type="datetime-local"
            aria-label="Starts"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>{' '}
        <label>
          Ends{' '}
          <input
            type="datetime-local"
            aria-label="Ends"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </p>
      <p>
        <label>
          Format{' '}
          <select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value)}>
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
            aria-label="Visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
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
        <button type="button" disabled={busy || name === ''} onClick={() => void save()}>
          Save contest
        </button>{' '}
        <Link to="/contests/$key" params={{ key: contestKey }}>
          Cancel
        </Link>
      </p>
    </section>
  );
}

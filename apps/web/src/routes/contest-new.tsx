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
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { api } from '../api.js';
import { useT } from '../i18n/index.js';
import { OrgPicker } from '../org-picker.js';

interface ProblemRow {
  code: string;
  points: string;
  partial: boolean;
}

/** The four formats the registry ships; the API refuses anything else. */
const FORMATS = ['default', 'icpc', 'ioi16', 'legacy_ioi'] as const;

/**
 * `/contests/new`, and — with `?cloneFrom=<key>` — D88's "Nhân bản kỳ thi".
 *
 * One screen for both, deliberately. A clone asks for exactly the four
 * things a copy cannot inherit (key, name, start, end) and the server copies
 * the rest, including the things this form has never been able to express at
 * all: `pointsPrecision`, `timeLimitSeconds`, `formatConfig` and a problem's
 * LABEL. A "prefilled create form" would therefore not be a copy — it would
 * silently drop those four fields on every clone, which is precisely the
 * kind of quiet loss a second implementation of "the same contest" produces.
 * So in clone mode the fields the server decides are shown as a read-only
 * summary rather than as inputs nobody's answer would be used from.
 */
export function ContestNewPage(props: { cloneFrom?: string } = {}) {
  const t = useT();
  const navigate = useNavigate();
  const cloneFrom = props.cloneFrom;
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [format, setFormat] = useState<string>('icpc');
  const [visibility, setVisibility] = useState<'public' | 'org' | 'private'>('private');
  // A string, like every other numeric field on this form: a number state
  // would turn a cleared box into `NaN` (or silently into 0) while the setter
  // is still typing.
  const [freeze, setFreeze] = useState('0');
  // D56: which schools may enter. Empty is the pre-D56 contest — anybody
  // who can see it may join.
  const [orgSlugs, setOrgSlugs] = useState<string[]>([]);
  const [rows, setRows] = useState<ProblemRow[]>([{ code: '', points: '100', partial: true }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState(false);

  const source = useQuery({
    queryKey: ['contest', cloneFrom],
    queryFn: async () => {
      const { data, error: err } = await api.GET('/contests/{key}', {
        params: { path: { key: cloneFrom! } },
      });
      if (err || !data) throw new Error(err?.code ?? 'contest_not_found');
      return data;
    },
    enabled: cloneFrom !== undefined,
  });

  // Seeded once, then left alone: this is a suggestion, and a form that
  // re-imposed it on every render would fight the person editing the name.
  // The key gets a `-2` rather than the source's own, which is taken by
  // definition — the server refuses a clash anyway (409 `contest_key_taken`)
  // and a field that arrives pre-refused is not a helpful default.
  useEffect(() => {
    if (seeded || !source.data) return;
    setKey(`${source.data.key}-2`);
    setName(t('contestNew.cloneNameSuggestion', { name: source.data.name }));
    setSeeded(true);
  }, [seeded, source.data, t]);

  function setRow(index: number, patch: Partial<ProblemRow>): void {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  /**
   * Clone: only the new window, key and name travel — everything else is the
   * source's, copied server-side where the labels and the config it carries
   * are actually reachable.
   */
  async function clone(): Promise<void> {
    if (start === '' || end === '') {
      setError(t('contestNew.datesRequired'));
      return;
    }
    setBusy(true);
    try {
      const { data, error: err } = await api.POST('/contests/{key}/clone', {
        params: { path: { key: cloneFrom! } },
        body: {
          newKey: key,
          newName: name,
          startTime: new Date(start).toISOString(),
          endTime: new Date(end).toISOString(),
        },
      });
      if (err || !data) {
        setError(err?.detail ?? err?.code ?? t('contestNew.createError'));
        return;
      }
      await navigate({ to: '/contests/$key', params: { key: data.key } });
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
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
    const frozenLastMinutes = Number(freeze);
    if (!Number.isInteger(frozenLastMinutes) || frozenLastMinutes < 0) {
      setError(t('contestNew.badFreeze'));
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
          orgSlugs,
          frozenLastMinutes,
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
      <h1>{cloneFrom === undefined ? t('contestNew.title') : t('contestNew.cloneTitle')}</h1>
      {cloneFrom !== undefined ? (
        <>
          <p>{t('contestNew.cloneIntro', { key: cloneFrom })}</p>
          {source.isLoading ? <p>{t('common.loading')}</p> : null}
          {source.data ? (
            <ul data-testid="clone-summary">
              <li>{t('contestNew.cloneFormat', { format: source.data.format })}</li>
              <li>{t('contestNew.cloneFreeze', { minutes: source.data.frozenLastMinutes })}</li>
              <li>
                {t('contestNew.cloneProblems', {
                  list: source.data.problems.map((p) => `${p.label}. ${p.code}`).join(', '),
                })}
              </li>
              <li>
                {t('contestNew.cloneOrgs', {
                  list:
                    source.data.orgs.length === 0
                      ? t('contestNew.cloneOrgsNone')
                      : source.data.orgs.map((o) => o.slug).join(', '),
                })}
              </li>
            </ul>
          ) : null}
        </>
      ) : null}
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
      {cloneFrom === undefined ? (
        <>
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
          {t('contestNew.freeze')}{' '}
          <input
            aria-label={t('contestNew.freeze')}
            value={freeze}
            onChange={(e) => setFreeze(e.target.value)}
          />
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

      <OrgPicker value={orgSlugs} onChange={setOrgSlugs} />

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
        </>
      ) : null}

      {error ? <p role="alert">{error}</p> : null}
      <p>
        <button
          type="button"
          disabled={busy || key === '' || name === ''}
          onClick={() => void (cloneFrom === undefined ? create() : clone())}
        >
          {cloneFrom === undefined ? t('contestNew.create') : t('contestNew.cloneSubmit')}
        </button>{' '}
        <Link to="/contests">{t('common.cancel')}</Link>
      </p>
    </section>
  );
}

/**
 * `/contests/$key/edit` — the screen `PATCH /contests/{key}` never had.
 *
 * Prefilled from `GET /contests/{key}`, and it sends only what the form can
 * actually express, so a field this page does not show is a field the request
 * leaves alone (the API reads an absent key as "keep"). `key` is not editable
 * here at all — see the request schema's own note. The contest's
 * organizations are, since D56.
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
import { apiError } from '../api-error.js';
import { useT } from '../i18n/index.js';
import { OrgPicker } from '../org-picker.js';
import { CodeAlert, LoadError, type CodeAlertState } from '../states.js';

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

/**
 * The instant to send for a `datetime-local` field, given what the form was
 * seeded with (m5).
 *
 * The field shows minutes, so a contest stored at `10:00:37Z` renders as
 * `10:00` and `new Date(value)` sends `10:00:00Z` back — an `endTime` up to
 * 59 seconds EARLIER than the one nobody touched. The participation window is
 * what `lower()` filters submissions on, so that silently voids a genuinely
 * last-minute submission, and it is a change to `startTime` the API now
 * refuses outright on a started contest (D38).
 *
 * So: a value the reader left exactly as it was seeded sends the ORIGINAL
 * instant back verbatim; anything else is a real edit and is parsed. This is
 * the whole rule, and it needs no `step` on the input — a field the browser
 * renders to the minute cannot express the seconds it is preserving.
 */
function instantFor(value: string, seed: { local: string; iso: string } | null): string {
  if (seed && value === seed.local) return seed.iso;
  return new Date(value).toISOString();
}

export function ContestEditPage({ contestKey }: { contestKey: string }) {
  const t = useT();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['contest', contestKey],
    queryFn: async (): Promise<ContestDetail> => {
      const result = await api.GET('/contests/{key}', {
        params: { path: { key: contestKey } },
      });
      if (result.error) throw apiError(result, t('contest.notFound'));
      return result.data;
    },
    // The local `retry: false` this used to carry is gone: `src/query.ts`
    // now refuses to repeat a 4xx for EVERY query, so an override here would
    // only hide the one case the global policy still retries — a 5xx.
  });

  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [format, setFormat] = useState<string>('icpc');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [freeze, setFreeze] = useState('0');
  // D99, seeded and sent back like every other field here. Both are refused
  // once the contest has started — but compared by VALUE, so re-sending what
  // is stored is the no-op it looks like (D38's rule), and this form is the
  // caller that depends on it.
  const [mode, setMode] = useState<'individual' | 'team'>('individual');
  const [maxTeamSize, setMaxTeamSize] = useState('3');
  const [orgSlugs, setOrgSlugs] = useState<string[]>([]);
  const [rows, setRows] = useState<ProblemRow[]>([]);
  const [error, setError] = useState<CodeAlertState>(null);
  const [busy, setBusy] = useState(false);

  // Which contest the form was seeded FROM — a key, not a boolean. The
  // router keys this component by `$key` as well (both, for the same reason
  // `problem-edit.tsx` documents): a form whose state survives a change of
  // key carries contest A's values into a save against contest B.
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  // What the two time fields were seeded WITH — the exact instants, beside the
  // minute-resolution strings the inputs show. `instantFor` sends the instant
  // back untouched when the string still matches (m5).
  const [startSeed, setStartSeed] = useState<{ local: string; iso: string } | null>(null);
  const [endSeed, setEndSeed] = useState<{ local: string; iso: string } | null>(null);
  useEffect(() => {
    const contest = query.data;
    if (!contest || seededFrom === contest.key) return;
    setName(contest.name);
    setStart(toLocalInput(contest.startTime));
    setEnd(toLocalInput(contest.endTime));
    setStartSeed({ local: toLocalInput(contest.startTime), iso: contest.startTime });
    setEndSeed({ local: toLocalInput(contest.endTime), iso: contest.endTime });
    setFormat(contest.format);
    setVisibility(contest.visibility);
    setMode(contest.participationMode);
    setMaxTeamSize(String(contest.maxTeamSize));
    // Seeded and sent back on every save, like every other field here: an
    // absent `orgSlugs` means keep, but a form that SHOWS the restriction and
    // then omits it is a form that lies about what it will save.
    setOrgSlugs(contest.orgs.map((org) => org.slug));
    // Prefilled and sent back on every save, like every other field here:
    // the PATCH reads an absent key as "keep", but a form that shows a value
    // it then omits is a form that lies about what it will save.
    setFreeze(String(contest.frozenLastMinutes));
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
        setError({ message: t('contestNew.badPoints', { code: row.code }) });
        return;
      }
    }
    if (start === '' || end === '') {
      setError({ message: t('contestNew.datesRequired') });
      return;
    }
    // `.trim() === ''` FIRST (m6): `Number('')` is 0 and `Number.isInteger(0)`
    // is true, so an emptied box used to sail through this check and PATCH
    // `frozenLastMinutes: 0` — the contest's freeze, switched off, with
    // nothing on screen saying so.
    const frozenLastMinutes = Number(freeze);
    if (freeze.trim() === '' || !Number.isInteger(frozenLastMinutes) || frozenLastMinutes < 0) {
      setError({ message: t('contestNew.badFreeze') });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await api.PATCH('/contests/{key}', {
        params: { path: { key: contestKey } },
        body: {
          name,
          startTime: instantFor(start, startSeed),
          endTime: instantFor(end, endSeed),
          format,
          visibility,
          participationMode: mode,
          maxTeamSize: Number(maxTeamSize),
          orgSlugs,
          frozenLastMinutes,
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
        setError({ message: err.detail ?? t('contestEdit.saveFailed'), code: err.code });
        return;
      }
      await navigate({ to: '/contests/$key', params: { key: contestKey } });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError({ message: t('common.networkError') });
    } finally {
      setBusy(false);
    }
  }

  if (query.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (query.error) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
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
          {t('contestNew.freeze')}{' '}
          <input
            type="number"
            min={0}
            step={1}
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

      <p>
        <label>
          {t('contest.colMode')}{' '}
          <select
            aria-label={t('contest.colMode')}
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="individual">{t('contest.modeIndividual')}</option>
            <option value="team">{t('contest.modeTeam')}</option>
          </select>
        </label>{' '}
        <label>
          {t('contest.maxTeamSize')}{' '}
          <input
            aria-label={t('contest.maxTeamSize')}
            value={maxTeamSize}
            onChange={(e) => setMaxTeamSize(e.target.value)}
          />
        </label>
      </p>
      <p className="muted">{t('contest.maxTeamSizeHint')}</p>

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

      {error ? <CodeAlert {...error} /> : null}
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

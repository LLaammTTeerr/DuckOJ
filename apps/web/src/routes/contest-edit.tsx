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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { useT } from '../i18n/index.js';
import { OrgPicker } from '../org-picker.js';
import { CodeAlert, LoadError, type CodeAlertState } from '../states.js';
import { ErrorSummary, FieldError, fieldProps, mapFieldErrors, useDirtyGuard } from '../forms.js';

type ContestDetail = paths['/contests/{key}']['get']['responses'][200]['content']['application/json'];
type Visibility = ContestDetail['visibility'];

/** The four formats the registry ships; the API refuses anything else. */
const FORMATS = ['default', 'icpc', 'ioi16', 'legacy_ioi'] as const;

/** The inputs D146's attribution can land on, keyed by their DOM ids. */
type Field = 'name' | 'start' | 'end' | 'freeze' | 'rows';
const FIELD_ORDER: readonly Field[] = ['name', 'start', 'end', 'freeze', 'rows'];

/**
 * `UpdateContestRequest`'s own paths -> this form's fields (D146). `key` is
 * absent because the schema refuses it: a contest's key is its URL.
 */
const SERVER_FIELDS: Readonly<Partial<Record<string, Field>>> = {
  name: 'name',
  startTime: 'start',
  endTime: 'end',
  frozenLastMinutes: 'freeze',
  maxTeamSize: 'rows',
  'problems.*.code': 'rows',
  'problems.*.points': 'rows',
};

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
 * The problem table, flattened to one comparable string (D147).
 *
 * The rows are objects rebuilt on every keystroke, so identity says nothing;
 * this is what lets "has anything changed?" be one `!==` rather than a
 * hand-written deep compare that would go stale the moment a column is added.
 */
function rowsFingerprint(rows: readonly ProblemRow[]): string {
  return rows.map((r) => `${r.code}\u0000${r.points}\u0000${String(r.partial)}`).join('\u0001');
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
  const client = useQueryClient();
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
  /** D146/D110 - see contest-new.tsx, which this mirrors clause for clause. */
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [attempt, setAttempt] = useState(0);

  // Which contest the form was seeded FROM — a key, not a boolean. The
  // router keys this component by `$key` as well (both, for the same reason
  // `problem-edit.tsx` documents): a form whose state survives a change of
  // key carries contest A's values into a save against contest B.
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  // What the two time fields were seeded WITH — the exact instants, beside the
  // minute-resolution strings the inputs show. `instantFor` sends the instant
  // back untouched when the string still matches (m5).
  const [startSeed, setStartSeed] = useState<{ local: string; iso: string } | null>(null);
  /**
   * Every field as the contest itself had it (D147). The prefill IS the
   * contest, so "dirty" can only mean "different from this" - measuring
   * against emptiness would warn an organiser who opened the page, read it
   * and pressed back.
   */
  const [seed, setSeed] = useState<{
    name: string;
    start: string;
    end: string;
    format: string;
    visibility: Visibility;
    mode: 'individual' | 'team';
    maxTeamSize: string;
    freeze: string;
    orgSlugs: string;
    rows: string;
  } | null>(null);
  const [endSeed, setEndSeed] = useState<{ local: string; iso: string } | null>(null);
  /**
   * The `version` this form was seeded WITH — D161. Sent back as
   * `expectedVersion` on every save, so a co-organiser's newer problem list
   * cannot be replaced by the one this form has been holding since before it
   * existed.
   */
  const [seededVersion, setSeededVersion] = useState<string | null>(null);
  /** A reseed happened: the round moved under an untouched form (D161). */
  const [reseeded, setReseeded] = useState(false);
  /** The last save was refused as a conflict, so the reload offer is on. */
  const [conflict, setConflict] = useState(false);
  /**
   * D147 - is there an edit here a route change would destroy?
   *
   * Compared against the SEED, not against emptiness: this form arrives
   * prefilled, and warning about the contest's own values would make the
   * guard fire on every visit and teach setters to click through it. `seed`
   * is null until the contest lands, and an unseeded form has nothing to lose.
   */
  const dirty =
    seed !== null &&
    (name !== seed.name ||
      start !== seed.start ||
      end !== seed.end ||
      format !== seed.format ||
      visibility !== seed.visibility ||
      mode !== seed.mode ||
      maxTeamSize !== seed.maxTeamSize ||
      freeze !== seed.freeze ||
      orgSlugs.join(',') !== seed.orgSlugs ||
      rowsFingerprint(rows) !== seed.rows);
  useEffect(() => {
    const contest = query.data;
    if (!contest) return;
    const first = seededFrom !== contest.key;
    // **D161, clause A** — `problem-edit.tsx` states the reasoning at length
    // and this is the same rule: an already-seeded form takes a newer copy
    // only when the record moved AND this organiser has typed nothing. A
    // dirty form keeps its typing and its stale `seededVersion`, and is
    // refused on save rather than allowed to overwrite. `dirty` is D147's own
    // comparison, moved above this effect so the two cannot drift apart —
    // "there is unsaved work here" has to mean one thing to the leave guard
    // and to the reseed, or one of them is wrong.
    if (!first && (dirty || contest.version === seededVersion)) return;
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
    setSeed({
      name: contest.name,
      start: toLocalInput(contest.startTime),
      end: toLocalInput(contest.endTime),
      format: contest.format,
      visibility: contest.visibility,
      mode: contest.participationMode,
      maxTeamSize: String(contest.maxTeamSize),
      freeze: String(contest.frozenLastMinutes),
      orgSlugs: contest.orgs.map((org) => org.slug).join(','),
      rows: rowsFingerprint(
        contest.problems.map((problem) => ({
          code: problem.code,
          points: String(problem.points),
          partial: problem.partial,
          label: problem.label,
        })),
      ),
    });
    setSeededVersion(contest.version);
    setSeededFrom(contest.key);
    // Announced, never silent (D161). Nothing was lost — the form had nothing
    // in it to lose — and an organiser who watches the problem list change on
    // its own deserves the sentence that explains it.
    if (!first) setReseeded(true);
  }, [seededFrom, seededVersion, dirty, query.data]);

  function setRow(index: number, patch: Partial<ProblemRow>): void {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  const release = useDirtyGuard(dirty);

  /**
   * D161. The organiser chose to take the newer version — explicitly, never
   * automatically: a conflict is by definition a form holding work, and
   * `problems` is the all-or-nothing field `ProblemRow` below already calls
   * out. The refetch is awaited before the seed guard reopens, so the effect
   * cannot seed synchronously from the stale entry still in the cache.
   */
  async function loadNewer(): Promise<void> {
    setBusy(true);
    try {
      await client.invalidateQueries({ queryKey: ['contest', contestKey] });
      setConflict(false);
      setError(null);
      setReseeded(false);
      setSeededFrom(null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * The contract's rules, in the active locale, before a request is sent.
   *
   * `contest_window_invalid` is a 400 with no field attribution at all, so an
   * organiser who typed the end before the start used to be handed an
   * identifier and left to work out which of the two boxes it meant.
   */
  function validate(): Partial<Record<Field, string>> {
    const invalid: Partial<Record<Field, string>> = {};
    if (name.trim() === '') invalid.name = t('form.required');
    if (start === '') invalid.start = t('form.required');
    if (end === '') invalid.end = t('form.required');
    else if (start !== '' && new Date(end) <= new Date(start)) {
      invalid.end = t('contestNew.errEndBeforeStart');
    }
    // `.trim() === ''` FIRST (m6): `Number('')` is 0 and `Number.isInteger(0)`
    // is true, so an emptied box used to sail through and PATCH
    // `frozenLastMinutes: 0` - the contest's freeze, switched off, silently.
    const frozen = Number(freeze);
    if (freeze.trim() === '' || !Number.isInteger(frozen) || frozen < 0) {
      invalid.freeze = t('contestNew.badFreeze');
    }
    for (const row of rows.filter((r) => r.code.trim() !== '')) {
      if (Number.isNaN(Number(row.points)) || Number(row.points) < 0) {
        invalid.rows = t('contestNew.badPoints', { code: row.code });
      }
    }
    return invalid;
  }

  async function save(): Promise<void> {
    if (busy) return;
    // Bumped on every attempt so the summary re-takes focus even when the
    // same fields fail twice in a row (D110).
    setAttempt((n) => n + 1);
    const invalid = validate();
    setFieldErrors(invalid);
    setError(null);
    if (Object.keys(invalid).length > 0) return;

    const problems = rows.filter((row) => row.code.trim() !== '');
    const frozenLastMinutes = Number(freeze);
    setBusy(true);
    try {
      const { data, error: err } = await api.PATCH('/contests/{key}', {
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
          // D161. Omitted rather than sent as `undefined`, on the same
          // `exactOptionalPropertyTypes` rule as `label` above.
          ...(seededVersion === null ? {} : { expectedVersion: seededVersion }),
        },
      });
      if (err) {
        // D161's refusal FIRST, ahead of D146: it carries no field
        // attribution and never will — the token is a hash of the whole
        // editable object, so there is no one box to point at — and routing
        // it through the field mapper would put it in the summary with
        // nothing to focus.
        if (err.code === 'contest_version_conflict') {
          setConflict(true);
          setError({ message: t('editConflict.contest'), code: err.code });
          return;
        }
        // D146: the server's own attribution beats a banner written in
        // the validation pipe's English.
        const attributed = mapFieldErrors(err.fields, SERVER_FIELDS);
        if (Object.keys(attributed).length > 0) {
          setFieldErrors(attributed);
          setAttempt((n) => n + 1);
          return;
        }
        setError({ message: err.detail ?? t('contestEdit.saveFailed'), code: err.code });
        return;
      }
      // Saved; the guard must not block the navigation that says so.
      release();
      // D161. This form navigates away on success, so the token below is
      // mostly belt and braces — but the navigation is awaited and can fail,
      // and a form left standing with a stale token would refuse its own next
      // save as a conflict with the write it just made.
      if (data) setSeededVersion(data.version);
      setConflict(false);
      setReseeded(false);
      // BEFORE the navigation, because the navigation's destination is one of
      // the readers: `/contests/$key` reads this very `['contest', contestKey]`
      // entry, so an uninvalidated save lands the organiser on the contest they
      // just edited, showing the times and problem list they just replaced.
      //
      // The worse half is this form itself. It is prefilled from the same key,
      // the seeding effect above runs ONCE per contest key, and a remount seeds
      // from the cache synchronously — before its own refetch can land. So an
      // organiser who saves and comes back inside `gcTime` gets the pre-save
      // form, and `problems` is the all-or-nothing field this file's own
      // `ProblemRow` comment calls out: the next save writes the old list back
      // and destroys the change.
      //
      // `['contests']` carries the name, times and visibility on the index.
      // `['scoreboard']` is included because `problems`, `points` and
      // `frozenLastMinutes` are the board's columns and its scoring — a board
      // left open across this save is scoring a contest that no longer exists.
      await client.invalidateQueries({ queryKey: ['contest', contestKey] });
      await client.invalidateQueries({ queryKey: ['contests'] });
      await client.invalidateQueries({ queryKey: ['scoreboard', contestKey] });
      await navigate({ to: '/contests/$key', params: { key: contestKey } });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` - see submit.tsx's handleSubmit for the pattern.
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
      {/* D110's Focusable Error Summary, reused rather than reinvented. */}
      <ErrorSummary errors={fieldErrors} order={FIELD_ORDER} attempt={attempt} />
      <p>
        <label>
          {t('common.name')}{' '}
          <input
            {...fieldProps('name', fieldErrors.name)}
            aria-label={t('common.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <FieldError id="name" message={fieldErrors.name} />
      </p>
      <p>
        <label>
          {t('contestNew.starts')}{' '}
          <input
            {...fieldProps('start', fieldErrors.start)}
            type="datetime-local"
            aria-label={t('contestNew.starts')}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <FieldError id="start" message={fieldErrors.start} />{' '}
        <label>
          {t('contestNew.ends')}{' '}
          <input
            {...fieldProps('end', fieldErrors.end)}
            type="datetime-local"
            aria-label={t('contestNew.ends')}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <FieldError id="end" message={fieldErrors.end} />
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
            {...fieldProps('freeze', fieldErrors.freeze)}
            type="number"
            min={0}
            step={1}
            aria-label={t('contestNew.freeze')}
            value={freeze}
            onChange={(e) => setFreeze(e.target.value)}
          />
        </label>
        <FieldError id="freeze" message={fieldErrors.freeze} />{' '}
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

      <h2 id="rows">{t('contestNew.problems')}</h2>
      <FieldError id="rows" message={fieldErrors.rows} />
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
      {/* D161. Beneath the message and beside the save button, and a button
          rather than an automatic reload: everything the organiser typed —
          `problems` above all — is still on screen and still copyable until
          they choose to give it up. D148 for the busy state. */}
      {conflict ? (
        <p>
          <button type="button" onClick={() => void loadNewer()} disabled={busy} aria-busy={busy}>
            {busy ? t('common.loading') : t('editConflict.load')}
          </button>
        </p>
      ) : null}
      {reseeded ? <p role="status">{t('editConflict.reseeded')}</p> : null}
      <p>
        {/* D148 - live unless it is genuinely busy, and it says what it is
            doing while it is. `disabled={name === ''}` used to grey it out
            with no reason given. */}
        <button type="button" disabled={busy} aria-busy={busy} onClick={() => void save()}>
          {busy ? t('form.saving') : t('contestEdit.save')}
        </button>{' '}
        <Link to="/contests/$key" params={{ key: contestKey }}>
          {t('common.cancel')}
        </Link>
      </p>
    </section>
  );
}

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
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { api } from '../api.js';
import { apiError, read } from '../api-error.js';
import { useT } from '../i18n/index.js';
import { CodeAlert, type CodeAlertState } from '../states.js';
import { OrgPicker } from '../org-picker.js';
import { ErrorSummary, FieldError, fieldProps, mapFieldErrors, useDirtyGuard } from '../forms.js';

interface ProblemRow {
  code: string;
  points: string;
  partial: boolean;
}

/** The four formats the registry ships; the API refuses anything else. */
const FORMATS = ['default', 'icpc', 'ioi16', 'legacy_ioi'] as const;

/**
 * The inputs D146's attribution can land on, keyed the way their DOM ids are
 * (`ErrorSummary` focuses by `getElementById`). `rows` is the problems TABLE,
 * which has no single input — the objection is shown above it.
 */
type Field = 'key' | 'name' | 'start' | 'end' | 'freeze' | 'rows';

/** Screen order, so the summary reads the way the form does. */
const FIELD_ORDER: readonly Field[] = ['key', 'name', 'start', 'end', 'freeze', 'rows'];

/**
 * `CONTEST_KEY` from `@duckoj/contracts`, copied here the way register.tsx
 * copies `Username`'s: a client rule that is merely SIMILAR to the server's
 * refuses keys the server would have taken, which is worse than not checking.
 */
const CONTEST_KEY = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * The request bodies' own paths → this form's fields (D146). Both endpoints,
 * because one page sends either: `POST /contests` names `key`/`startTime`,
 * `POST /contests/{key}/clone` names `newKey`/`newName`.
 */
const SERVER_FIELDS: Readonly<Partial<Record<string, Field>>> = {
  key: 'key',
  newKey: 'key',
  name: 'name',
  newName: 'name',
  startTime: 'start',
  endTime: 'end',
  frozenLastMinutes: 'freeze',
  maxTeamSize: 'rows',
  'problems.*.code': 'rows',
  'problems.*.points': 'rows',
};

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
  // D99. `individual` is the default here as it is in the schema, so a form
  // nobody touches creates the contest this product has always created.
  const [mode, setMode] = useState<'individual' | 'team'>('individual');
  const [maxTeamSize, setMaxTeamSize] = useState('3');
  // D56: which schools may enter. Empty is the pre-D56 contest — anybody
  // who can see it may join.
  const [orgSlugs, setOrgSlugs] = useState<string[]>([]);
  const [rows, setRows] = useState<ProblemRow[]>([{ code: '', points: '100', partial: true }]);
  // `{ message, code }` (D145): the sentence a setter reads, and the
  // server's identifier beside it — this screen used to show the
  // identifier ALONE (`contest_key_taken`) as the whole message.
  const [error, setError] = useState<CodeAlertState>(null);
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState(false);
  /**
   * D146/D110. `fieldErrors` changes only inside `handleSubmit` — typing
   * edits the values, never the errors — which is what lets `ErrorSummary`
   * take focus once per failed attempt without ever stealing it mid-typing.
   */
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [attempt, setAttempt] = useState(0);
  /**
   * What the form held when it was seeded: '' for a fresh create, the source
   * contest's suggestion for a clone. Anything else in these two boxes is the
   * setter's own typing.
   */
  const [baseline, setBaseline] = useState({ key: '', name: '' });

  const source = useQuery({
    queryKey: ['contest', cloneFrom],
    queryFn: async () => {
      const result = await api.GET('/contests/{key}', {
        params: { path: { key: cloneFrom! } },
      });
      // D145 — was `new Error(err?.code)`, which put `contest_not_found` on
      // screen as a sentence and threw the STATUS away with it, so
      // `src/query.ts` retried a 404 three times before saying so.
      const data = read(result, t('contest.notFound'));
      if (data === null) throw apiError(result, t('contest.notFound'));
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
    const suggestion = {
      key: `${source.data.key}-2`,
      name: t('contestNew.cloneNameSuggestion', { name: source.data.name }),
    };
    setKey(suggestion.key);
    setName(suggestion.name);
    // The suggestion is not the setter's work — D147 must not warn about it.
    setBaseline(suggestion);
    setSeeded(true);
  }, [seeded, source.data, t]);

  /**
   * D147 — is there work here a route change would destroy? The four
   * substantial answers (the two names, the window, the problem list), not
   * every select: a format nobody changed back is five seconds, a problem
   * list is not.
   */
  const dirty =
    key !== baseline.key ||
    name !== baseline.name ||
    start !== '' ||
    end !== '' ||
    orgSlugs.length > 0 ||
    rows.some((row) => row.code.trim() !== '');
  const release = useDirtyGuard(dirty);

  /**
   * The contract's rules, in the active locale, before a request is sent.
   *
   * Every one of these used to be either a dead button (`key === ''` simply
   * greyed it out, naming nothing) or a round trip: `contest_window_invalid`
   * comes back as a 400 with NO field attribution at all, so a setter who put
   * the end before the start was told an identifier and left to guess which
   * of the two boxes it meant.
   */
  const validate = useMemo(
    () =>
      function validateForm(): Partial<Record<Field, string>> {
        const invalid: Partial<Record<Field, string>> = {};
        if (key.trim() === '') invalid.key = t('form.required');
        else if (!CONTEST_KEY.test(key)) invalid.key = t('contestNew.errKeyFormat');
        if (name.trim() === '') invalid.name = t('form.required');
        if (start === '') invalid.start = t('form.required');
        if (end === '') invalid.end = t('form.required');
        else if (start !== '' && new Date(end) <= new Date(start)) {
          invalid.end = t('contestNew.errEndBeforeStart');
        }
        if (cloneFrom === undefined) {
          const frozen = Number(freeze);
          if (freeze.trim() === '' || !Number.isInteger(frozen) || frozen < 0) {
            invalid.freeze = t('contestNew.badFreeze');
          }
          for (const row of rows.filter((r) => r.code.trim() !== '')) {
            if (Number.isNaN(Number(row.points)) || Number(row.points) < 0) {
              invalid.rows = t('contestNew.badPoints', { code: row.code });
            }
          }
        }
        return invalid;
      },
    [key, name, start, end, freeze, rows, cloneFrom, t],
  );

  /**
   * The one entry point both buttons used to have separately. Validation,
   * then the request, then — only on success — the guard is released and the
   * page navigates.
   */
  async function handleSubmit(): Promise<void> {
    if (busy) return;
    // Bumped on every attempt so the summary re-takes focus even when the
    // same fields fail twice in a row (D110's own note).
    setAttempt((n) => n + 1);
    const invalid = validate();
    setFieldErrors(invalid);
    setError(null);
    if (Object.keys(invalid).length > 0) return;
    await (cloneFrom === undefined ? create() : clone());
  }

  /**
   * A refusal, filed where the server filed it. Answers whether it was
   * attributable, so the caller knows not to ALSO raise a banner saying the
   * same thing in the pipe's English.
   */
  function attribute(err: { code?: string | undefined; fields?: Record<string, string[]> | undefined }): boolean {
    const attributed = mapFieldErrors(err.fields, SERVER_FIELDS);
    if (Object.keys(attributed).length === 0) return false;
    setFieldErrors(attributed);
    setAttempt((n) => n + 1);
    return true;
  }

  function setRow(index: number, patch: Partial<ProblemRow>): void {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  /**
   * Clone: only the new window, key and name travel — everything else is the
   * source's, copied server-side where the labels and the config it carries
   * are actually reachable.
   */
  async function clone(): Promise<void> {
    // The date check lives in `validate()` now, beside the field it is about.
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
        // D146 first: the server's own attribution beats a banner.
        if (err && attribute(err)) return;
        setError({ message: err?.detail ?? t('contestNew.createError'), code: err?.code });
        return;
      }
      // The work is saved; the guard must not block the navigation that says so.
      release();
      await navigate({ to: '/contests/$key', params: { key: data.key } });
    } catch {
      setError({ message: t('common.networkError') });
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    // Points, window and freeze are all `validate()`'s now — checked before
    // this runs, and reported beside the field rather than in one banner.
    const problems = rows.filter((row) => row.code.trim() !== '');
    const frozenLastMinutes = Number(freeze);
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
          participationMode: mode,
          maxTeamSize: Number(maxTeamSize),
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
        if (attribute(err)) return;
        setError({ message: err.detail ?? t('contestNew.createError'), code: err.code });
        return;
      }
      release();
      await navigate({ to: '/contests/$key', params: { key: data.key } });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError({ message: t('common.networkError') });
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
      {/* D110's Focusable Error Summary, reused rather than reinvented: the
          failure is announced, focus lands on the list, and each item carries
          a keyboard reader to the field it names. */}
      <ErrorSummary errors={fieldErrors} order={FIELD_ORDER} attempt={attempt} />
      <p>
        {/* The `<label>` WRAPS the input, so the objection is rendered
            OUTSIDE it — inside, the error text would fold into the field's
            accessible NAME and every `getByLabelText` for it would stop
            matching. See register.tsx's note. */}
        <label>
          {t('contestNew.key')}{' '}
          <input
            {...fieldProps('key', fieldErrors.key)}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="spring-open"
          />
        </label>
        <FieldError id="key" message={fieldErrors.key} />
      </p>
      <p>
        <label>
          {t('common.name')}{' '}
          <input
            {...fieldProps('name', fieldErrors.name)}
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
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <FieldError id="end" message={fieldErrors.end} />
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
            {...fieldProps('freeze', fieldErrors.freeze)}
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
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
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
          {/* The VALUE is the API's enum and the LABEL is prose, so only the
              label is translated — the visibility select's rule. */}
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
        </>
      ) : null}

      {error ? <CodeAlert {...error} /> : null}
      <p>
        {/* D148 — live unless it is genuinely busy, and it says what it is
            doing while it is. `disabled={key === ''}` used to grey it out
            with no reason given: eleven inputs and no clue which one. */}
        <button type="button" disabled={busy} aria-busy={busy} onClick={() => void handleSubmit()}>
          {busy
            ? t('form.creating')
            : cloneFrom === undefined
              ? t('contestNew.create')
              : t('contestNew.cloneSubmit')}
        </button>{' '}
        <Link to="/contests">{t('common.cancel')}</Link>
      </p>
    </section>
  );
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { formatPoints } from '../format.js';
import { useT, verdictName, type MsgKey, type TFunction } from '../i18n/index.js';

export type SubmissionDetail =
  paths['/submissions/{id}']['get']['responses'][200]['content']['application/json'];
type SubmissionCase = SubmissionDetail['cases'][number];
type SubmissionState = SubmissionDetail['state'];

// A state's message KEY is a constant; the message itself is not, so this
// maps to keys and the lookup happens per render inside `VerdictPanel`. The
// old module-level `Record<SubmissionState, string>` held five English
// sentences that no locale switch could ever reach.
const STATE_KEYS: Record<SubmissionState, MsgKey> = {
  queued: 'state.queued',
  compiling: 'state.compiling',
  grading: 'state.grading',
  done: 'state.done',
  errored: 'state.errored',
};

const TERMINAL_STATES: ReadonlySet<SubmissionState> = new Set(['done', 'errored']);

export interface SubmitValues {
  languageKey: string;
  source: string;
}

/**
 * Presentational only: props in, callback out. No server access, so it is
 * testable on its own.
 */
export function SubmitForm(props: {
  onSubmit: (values: SubmitValues) => Promise<void> | void;
  languages: string[];
  busy: boolean;
}) {
  const t = useT();
  const [languageKey, setLanguageKey] = useState(() => props.languages[0] ?? '');
  const [source, setSource] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    void props.onSubmit({ languageKey, source });
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="language">{t('submit.language')}</label>
      <select id="language" value={languageKey} onChange={(e) => setLanguageKey(e.target.value)}>
        {/* The option text is the API's own language key (`cpp17`), which is
            an identifier, not a word — untranslated on purpose. */}
        {props.languages.map((lang) => (
          <option key={lang} value={lang}>
            {lang}
          </option>
        ))}
      </select>
      <label htmlFor="source">{t('submit.sourceCode')}</label>
      <textarea id="source" value={source} onChange={(e) => setSource(e.target.value)} />
      <button type="submit" disabled={props.busy}>
        {t('submit.submit')}
      </button>
    </form>
  );
}

function caseLabel(t: TFunction, c: SubmissionCase): string {
  return c.skipped ? t('submit.skipped') : String(c.verdict);
}

/**
 * Maps a verdict (or the absence of one) to the lowercase token app.css keys
 * its `.badge`/`.case` colour+glyph rules on — see that file's header
 * comment. `null` (no verdict yet) maps to the same neutral `pend` token
 * app.css also uses for an unpublished revision (problem-revisions.tsx).
 *
 * Exported so every other screen that renders a verdict — the problem
 * list's `me` column and the submissions list (routes/problems.tsx,
 * routes/submissions.tsx) — maps it through this one function rather than
 * a second copy of the same `.toLowerCase() / 'pend'` rule. "Verdicts use
 * the same badge glyph+colour system you already built" covers the mapper,
 * not just the CSS classes it feeds.
 */
export function verdictToken(verdict: SubmissionDetail['verdict']): string {
  return verdict ? verdict.toLowerCase() : 'pend';
}

/** Hover text for a case-grid cell — the on-screen glyph is just a number
 * and a colour; this is where the actual verdict, timing and memory live
 * for anyone who points at a box instead of reading the `.sr-only` text. */
function caseTitle(t: TFunction, c: SubmissionCase): string {
  const label = t('submit.case', { group: c.groupIndex, index: c.caseIndex });
  if (c.skipped) return `${label}: ${t('submit.skipped')}`;
  // This is the one place the verdict's localized LONG NAME appears beside
  // its code — the brief's "codes stay codes, names get translated in
  // tooltips" rule, and this is the tooltip.
  const verdict = c.verdict ? `${c.verdict} — ${verdictName(t, c.verdict)}` : t('submit.pending');
  return `${label}: ${verdict} · ${c.timeMs} ms · ${c.memoryKb} KB`;
}

/**
 * Renders whatever the API currently knows about a submission. The caller is
 * responsible for keeping `submission` fresh (see `SubmitPage` below) — this
 * component only renders a snapshot.
 */
export function VerdictPanel(props: { submission: SubmissionDetail }) {
  const t = useT();
  const { submission } = props;
  // `compileOutput` is NOT a compile-failure flag — it's a free-text channel
  // written by three different events (see apps/judged/src/event-writer.ts):
  // a non-fatal `compileMessage` (compiler *warnings*, submission keeps
  // grading normally), a fatal `compileError`, and an unrelated
  // `internalError` (judge-side failure, nothing to do with the user's code).
  // Only the second is an actual compile failure, and since Phase 2b Task 9
  // it has a verdict of its own: `compileError` writes `verdict: 'CE'`, while
  // `internalError` still writes `'IE'`. The verdict alone now separates the
  // three:
  //   - compileMessage (warning):  compileOutput set, verdict AC/WA/…
  //   - compileError:              verdict 'CE'
  //   - internalError:             verdict 'IE', state 'errored'
  //
  // This predicate previously read `state === 'done' && verdict === 'IE' &&
  // compileOutput` — correct before Task 9 and unreachable after it, so a
  // compile error rendered as a bare "IE" with no test anywhere to notice
  // (no test in apps/web/test covered this branch at all). Task 13 found it
  // by submitting uncompilable source against the live stack and getting
  // `CE` back. `compileOutput` is deliberately NOT part of the condition
  // any more: `CE` means the compile failed whether or not the compiler
  // managed to say why.
  const isCompileError = submission.verdict === 'CE';
  const stateLabel = t(STATE_KEYS[submission.state]);

  return (
    <section>
      <p>{t('submit.status', { state: stateLabel })}</p>
      {submission.frozen ? (
        // D23. Checked BEFORE the verdict branches, not after: a frozen
        // submission arrives with `verdict: null`, so without this it would
        // render as nothing at all and read as "not graded yet".
        <p>
          {t('submit.verdict')}{' '}
          <strong className="badge pend" title={t('submission.frozen')}>
            ?
          </strong>
        </p>
      ) : isCompileError ? (
        <p>
          {t('submit.verdict')}{' '}
          {/* The one verdict rendered by its long name rather than its code:
              a compile error never has a per-case grid to explain it, so the
              name is all the reader gets. */}
          <strong className="badge ce">{t('verdict.CE')}</strong>
        </p>
      ) : submission.verdict ? (
        <p>
          {t('submit.verdict')}{' '}
          <strong
            className={`badge ${verdictToken(submission.verdict)}`}
            title={verdictName(t, submission.verdict)}
          >
            {submission.verdict}
          </strong>
          {typeof submission.points === 'number' && typeof submission.maxPoints === 'number' ? (
            <small>
              {' '}
              — {formatPoints(submission.points)}/{formatPoints(submission.maxPoints)}
            </small>
          ) : null}
        </p>
      ) : null}
      {submission.compileOutput ? (
        // Rendered whenever there's compiler/judge output at all — including
        // a warning on an otherwise-passing submission, where it must sit
        // *alongside* the real verdict above, never replace it.
        <div>
          <p>{t('submit.compilerOutput')}</p>
          <pre>{submission.compileOutput}</pre>
        </div>
      ) : null}
      {submission.cases.length > 0 ? (
        // A real <ul>/<li> list — role=list/listitem, asserted directly by
        // test/submit.spec.tsx — styled by app.css's `.cases`/`.case` into a
        // dense grid. Each cell's visible content is just the case's
        // sequential position and a colour; the full "Case G.C: verdict"
        // sentence (including the literal word "skipped" for a case that
        // never ran — that word is asserted directly, and skipped MUST say
        // so rather than merely looking faint to a sighted reader) lives in
        // `.sr-only` text and in `title` for anyone hovering.
        <ul className="cases">
          {submission.cases.map((c, i) => (
            <li
              key={`${c.groupIndex}-${c.caseIndex}`}
              className={`case ${c.skipped ? 'skip' : verdictToken(c.verdict)}`}
              title={caseTitle(t, c)}
            >
              <span aria-hidden="true">{i + 1}</span>
              <span className="sr-only">
                {t('submit.case', { group: c.groupIndex, index: c.caseIndex })}:{' '}
                {caseLabel(t, c)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// Phase 1 had no problem browser, so this page's problem code was a fixed
// `aplusb` and its language list a fixed `['cpp17']`. Phase 2b's problem page
// then started linking here as `/submit?problem=<code>`
// (`routes/problem.tsx`) while this constant stayed hardcoded — so "Submit a
// solution" on `hello`, or on any problem authored through the new forms,
// silently submitted against `aplusb` instead. Nothing caught it: every unit
// test here renders `SubmitForm`/`VerdictPanel` directly and never reads the
// URL, and the API answered a perfectly valid request for a different
// problem than the one on screen. Found by Task 13, browsing the live stack.
//
// The language list stays fixed: `cpp17` is still the only language with a
// driver key that reaches a real dmoj executor (see scripts/seed-problem.ts's
// `languageDriverKeys` insert), and there is still no language catalog
// endpoint to populate it from.
export const DEFAULT_PROBLEM_CODE = 'aplusb';
const LANGUAGES = ['cpp17'];

/**
 * The problem this page submits against, read from `?problem=<code>`.
 *
 * Deliberately no client-side validation of the code's shape: the code is
 * only ever sent to the API — which validates it and answers
 * `problem_not_found` for anything it does not recognise, the same as for a
 * problem the caller may not see — and rendered as React text, which escapes
 * it. A local copy of contracts' `PROBLEM_CODE` regex here would be a fourth
 * place for that pattern to drift, buying nothing.
 *
 * Falls back to `aplusb` when the parameter is absent so bare `/submit` (and
 * `/`, which renders this page too) behaves exactly as it did before.
 */
export function problemCodeFromSearch(search: string): string {
  return new URLSearchParams(search).get('problem') ?? DEFAULT_PROBLEM_CODE;
}

// Reconnect backoff, not a tight loop. Capped rather than unbounded so a
// long-stuck grade doesn't end up polling every ten seconds forever, but
// still short enough that a network blip recovers quickly.
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000];

/**
 * Owns the WebSocket. On mount (and on every id change) it opens `/ws` on the
 * same origin as the page — authentication is the session cookie, sent
 * automatically; there is never a credential in the URL. Order is subscribe
 * *then* fetch, on first connect and every reconnect: a frame that arrives
 * between fetching and subscribing would be delivered to nobody, and since
 * there is no event log to replay, a finished submission would then show its
 * last-known state forever. Subscribing first has no equivalent hazard — an
 * early frame just triggers another fetch.
 *
 * Owns the actual WebSocket lifecycle for one submission id. Extracted out
 * of `SubmitPage` so its <StrictMode> cleanup behaviour (D3) can be exercised
 * directly in `test/submission-socket.spec.tsx`, independent of the
 * click-driven flow that normally activates it — `submissionId` starts
 * `null` in `SubmitPage`, so under the real app's usual flow this effect
 * only ever becomes active *after* the initial mount/unmount/remount cycle
 * React's StrictMode performs at mount, which is a real, verified property
 * of React (double-invoking an effect happens around a component's own
 * initial mount, not around a later dependency change) but not a substitute
 * for the cleanup being correct in general — a future caller could easily
 * pass an id that is already known at first render.
 */
export function useSubmissionSocket(
  submissionId: number | null,
  fetchSubmission: (id: number) => Promise<void>,
  terminalRef: { current: boolean },
  onSubscriptionError?: (code: string) => void,
): void {
  useEffect(() => {
    if (submissionId === null) return;
    // TS does not carry the null-check narrowing above into the closures
    // below, so bind a locally-narrowed `number` alias for them to capture.
    const id = submissionId;

    // `disposed` (plus the reconnect timer handle) is what makes the cleanup
    // below safe to run while a socket is still CONNECTING: closing a
    // CONNECTING socket is spec-legal on its own, but the real hazard is that
    // it fires this same effect run's `close` handler, which — without this
    // flag — would schedule a reconnect *after* the effect has already been
    // torn down. Under <StrictMode>'s mount→unmount→remount, that reconnect
    // would land on an orphaned closure and double every subsequent re-fetch.
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // openapi-fetch has no `onError` middleware registered, so a
    // network-level failure (not an HTTP error response — an actual refused
    // connection, a DNS failure, the API restarting mid-request) rethrows
    // out of `fetchSubmission` instead of resolving to `{ error }`. Called
    // via `void`, that would otherwise be an unhandled rejection every time
    // it happens. It's transient — the reconnect loop or the next signal
    // frame will prompt another attempt — so it's logged, not surfaced.
    function safeFetch(fetchId: number): void {
      fetchSubmission(fetchId).catch((err: unknown) => {
        console.error('submission re-fetch failed', err);
      });
    }

    function connect(): void {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      // Same-origin only, and never a credential in the URL — the gateway
      // authenticates from the session cookie, sent automatically. A
      // `?token=` here would leak into access logs, proxy logs and browser
      // history, and Task 11's gateway rejects a query-string credential on
      // purpose (see D1).
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      socket = ws;

      ws.addEventListener('open', () => {
        if (disposed) return;
        attempt = 0;
        ws.send(JSON.stringify({ type: 'subscribe', submissionId: id }));
        // Provisional; the authoritative fetch fires on the 'subscribed' ack.
        safeFetch(id);
      });

      ws.addEventListener('message', (event) => {
        if (disposed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) return;
        const frame = parsed as { type?: unknown; id?: unknown; code?: unknown };
        // The frame is a signal only and carries no grading data — only its
        // `id` is read. A frame for a different submission is ignored.
        if (frame.type === 'submission' && frame.id === id) {
          safeFetch(id);
          return;
        }
        // The gateway's proof that the subscription is live. The open-time
        // fetch below is provisional (it races the server-side add — a
        // terminal event in that window was permanently lost); this one is
        // authoritative: any event after it will be delivered, so together
        // they close the gap. An ack for a stale id is ignored like any
        // other frame for a different submission.
        if (frame.type === 'subscribed' && frame.id === id) {
          safeFetch(id);
          return;
        }
        if (frame.type === 'error') {
          // The gateway sends this only when the subscribe was rejected
          // (the caller may not watch this submission). Not reachable today
          // — a caller only ever subscribes to a submission it just created
          // and owns — but if that ever changed, silently dropping this
          // would leave the page sitting on its last fetch forever: nothing
          // else will ever prompt another re-fetch for a rejected id.
          onSubscriptionError?.(typeof frame.code === 'string' ? frame.code : 'subscription_error');
        }
      });

      ws.addEventListener('close', () => {
        if (disposed || terminalRef.current) return;
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [submissionId, fetchSubmission, terminalRef, onSubscriptionError]);
}

/**
 * `problemCode` is supplied by the caller (`router.tsx`'s `/submit` route,
 * via `validateSearch` + `useSearch`) rather than read from
 * `window.location.search` directly here, as it was before this app adopted
 * a router.
 *
 * That is not a cosmetic change: TanStack Router's default search
 * serializer (`defaultStringifySearch`, `@tanstack/router-core`) quotes a
 * search value with `JSON.stringify` whenever the raw string would itself
 * `JSON.parse` successfully on the other end — verified directly against
 * the installed version rather than assumed. Most problem codes (`aplusb`,
 * `triangle`, `hello`) are not valid JSON on their own and pass through
 * unquoted, but contracts' `PROBLEM_CODE` grammar
 * (`/^[a-z0-9][a-z0-9_-]{1,63}$/`) also permits a code that IS — an
 * all-digit code like `123`, or the literal `true`/`false`/`null` — and
 * those round-trip as `?problem=%22123%22`, quotes included. The router's
 * own `useSearch`/`validateSearch` pipeline JSON-decodes that back to the
 * bare string (confirmed for exactly this case); a hand-rolled `new
 * URLSearchParams(...).get('problem')` (what `problemCodeFromSearch` below
 * still does, correctly, for a *raw* query string someone typed by hand)
 * would not, and would silently submit against a code with literal quote
 * characters in it for that narrow case — the same shape of bug Task 13 of
 * Phase 2b found here already, just with a different cause. See
 * `router.tsx`'s `submitRoute` for where the value actually comes from.
 */
/**
 * `contestKey` is the 4d obligation made visible: a submission counts toward a
 * contest only if the key travels with it. Reaching this page from a contest's
 * problem table carries it; reaching it from the problem page does not, and
 * that submission is practice — which is the cost of the explicit-key design,
 * surfaced here rather than hidden.
 */
export function SubmitPage(props: { problemCode: string; contestKey?: string }) {
  const t = useT();
  const { problemCode } = props;
  const [submissionId, setSubmissionId] = useState<number | null>(null);
  const [submission, setSubmission] = useState<SubmissionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Read by the WebSocket effect's async callbacks, which close over a given
  // render's `submissionId` — this ref lets them check against the *current*
  // one instead, so a fetch started for a superseded submission can't clobber
  // the state of the one now on screen.
  const submissionIdRef = useRef(submissionId);
  submissionIdRef.current = submissionId;

  // Same idea for terminality: read from a ref (updated every render, below)
  // rather than added to the effect's dependency array, so reaching a
  // terminal state doesn't itself tear down and reopen the socket.
  const terminalRef = useRef(false);
  terminalRef.current = submission ? TERMINAL_STATES.has(submission.state) : false;

  const fetchSubmission = useCallback(async (id: number) => {
    const { data } = await api.GET('/submissions/{id}', { params: { path: { id } } });
    if (data && submissionIdRef.current === id) {
      setSubmission(data);
    }
  }, []);

  const handleSubscriptionError = useCallback(
    (code: string) => {
      setSubmitError(t('submit.liveUnavailable', { code }));
    },
    [t],
  );

  useSubmissionSocket(submissionId, fetchSubmission, terminalRef, handleSubscriptionError);

  async function handleSubmit(values: SubmitValues): Promise<void> {
    setBusy(true);
    setSubmitError(null);
    try {
      const { data, error } = await api.POST('/submissions', {
        body: {
          problemCode,
          languageKey: values.languageKey,
          source: values.source,
          ...(props.contestKey ? { contestKey: props.contestKey } : {}),
        },
      });
      if (error || !data) {
        setSubmitError(error?.detail ?? t('submit.failed'));
        return;
      }
      setSubmission(null);
      setSubmissionId(data.id);
    } catch {
      // openapi-fetch rethrows network-level failures (no `onError`
      // middleware registered) rather than returning them as `{ error }` —
      // a refused connection, a DNS failure, or the API restarting
      // mid-request all land here instead of the `error` branch above.
      // Without this, busy still resets via `finally`, but the click
      // otherwise does nothing visible.
      setSubmitError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>{t('submit.title', { code: problemCode })}</h1>
      {/* m23 — this is the one screen where practice and competing are
          actually chosen, and it never said which it was doing. `contestKey`
          decides whether a `contest_submissions` row is written at all, and a
          submission that silently went to practice is unrecoverable: the
          window closes and it never counted. A hyperlink, like every other
          entity on this site. */}
      {props.contestKey === undefined ? (
        <p className="muted">{t('submit.practice')}</p>
      ) : (
        <p role="status">
          {t('submit.intoContest')}{' '}
          <Link to="/contests/$key" params={{ key: props.contestKey }}>
            {props.contestKey}
          </Link>
        </p>
      )}
      <SubmitForm onSubmit={handleSubmit} languages={LANGUAGES} busy={busy} />
      {submitError ? <p role="alert">{submitError}</p> : null}
      {submission ? <VerdictPanel submission={submission} /> : null}
    </section>
  );
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { paths } from '@qhhoj/sdk';
import { api } from '../api.js';

export type SubmissionDetail =
  paths['/submissions/{id}']['get']['responses'][200]['content']['application/json'];
type SubmissionCase = SubmissionDetail['cases'][number];
type SubmissionState = SubmissionDetail['state'];

const STATE_LABELS: Record<SubmissionState, string> = {
  queued: 'Queued',
  compiling: 'Compiling',
  grading: 'Grading',
  done: 'Done',
  errored: 'Errored',
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
  const [languageKey, setLanguageKey] = useState(() => props.languages[0] ?? '');
  const [source, setSource] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    void props.onSubmit({ languageKey, source });
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="language">Language</label>
      <select id="language" value={languageKey} onChange={(e) => setLanguageKey(e.target.value)}>
        {props.languages.map((lang) => (
          <option key={lang} value={lang}>
            {lang}
          </option>
        ))}
      </select>
      <label htmlFor="source">Source code</label>
      <textarea id="source" value={source} onChange={(e) => setSource(e.target.value)} />
      <button type="submit" disabled={props.busy}>
        Submit
      </button>
    </form>
  );
}

function caseLabel(c: SubmissionCase): string {
  return c.skipped ? 'skipped' : String(c.verdict);
}

/**
 * Renders whatever the API currently knows about a submission. The caller is
 * responsible for keeping `submission` fresh (see `SubmitPage` below) — this
 * component only renders a snapshot.
 */
export function VerdictPanel(props: { submission: SubmissionDetail }) {
  const { submission } = props;
  // `compileOutput` is NOT a compile-failure flag — it's a free-text channel
  // written by three different events (see apps/judged/src/event-writer.ts):
  // a non-fatal `compileMessage` (compiler *warnings*, submission keeps
  // grading normally), a fatal `compileError`, and an unrelated
  // `internalError` (judge-side failure, nothing to do with the user's code).
  // Only the second is an actual compile failure. The `case_verdict` enum
  // has no CE member, so `compileError` is written as the misleading
  // `verdict: 'IE'` — the same value `internalError` uses — so `state`
  // must be checked too: `compileError` always finishes in `state: 'done'`,
  // while `internalError` finishes in `state: 'errored'`. That's what
  // distinguishes the three:
  //   - compileMessage (warning):  compileOutput set, verdict likely AC/WA/…
  //   - compileError:              state 'done',    verdict 'IE'
  //   - internalError:             state 'errored', verdict 'IE'
  // Deliberately not fixed at the data model here — see task-13-brief.md's
  // "two things that will bite you" and task-15's F3: the real fix is a
  // Phase 2 change (submission-level outcomes need to stop sharing an enum
  // with per-case verdicts). One residual edge this predicate cannot
  // separate with data currently on the wire: a submission that emits a
  // compiler warning and *then* finishes 'IE' from a genuine case-level
  // internal error also reads as a compile error here — rare, and not
  // resolvable without more data than the API currently exposes.
  const isCompileError =
    submission.state === 'done' && submission.verdict === 'IE' && Boolean(submission.compileOutput);
  const stateLabel = STATE_LABELS[submission.state];

  return (
    <section>
      <p>Status: {stateLabel}</p>
      {isCompileError ? (
        <p>
          Verdict: <strong>Compile error</strong>
        </p>
      ) : submission.verdict ? (
        <p>
          Verdict: <strong>{submission.verdict}</strong>
          {typeof submission.points === 'number' && typeof submission.maxPoints === 'number'
            ? ` — ${submission.points}/${submission.maxPoints}`
            : null}
        </p>
      ) : null}
      {submission.compileOutput ? (
        // Rendered whenever there's compiler/judge output at all — including
        // a warning on an otherwise-passing submission, where it must sit
        // *alongside* the real verdict above, never replace it.
        <div>
          <p>Compiler output:</p>
          <pre>{submission.compileOutput}</pre>
        </div>
      ) : null}
      {submission.cases.length > 0 ? (
        <ul>
          {submission.cases.map((c) => (
            <li key={`${c.groupIndex}-${c.caseIndex}`}>
              Case {c.groupIndex}.{c.caseIndex}: {caseLabel(c)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// Phase 1 has no problem browser and no language catalog endpoint, so both
// are fixed here rather than built as general UI — the only problem seeded
// for this phase is `aplusb` (see scripts/seed-problem.ts), and `cpp17` is
// the only language it grades (see packages/judge-protocol's fake driver and
// judge/judge.yml). Deliberately not general-purpose: see task brief D5.
const PROBLEM_CODE = 'aplusb';
const LANGUAGES = ['cpp17'];

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

export function SubmitPage() {
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

  const handleSubscriptionError = useCallback((code: string) => {
    setSubmitError(`Live updates unavailable (${code}). Refresh to see the latest state.`);
  }, []);

  useSubmissionSocket(submissionId, fetchSubmission, terminalRef, handleSubscriptionError);

  async function handleSubmit(values: SubmitValues): Promise<void> {
    setBusy(true);
    setSubmitError(null);
    try {
      const { data, error } = await api.POST('/submissions', {
        body: { problemCode: PROBLEM_CODE, languageKey: values.languageKey, source: values.source },
      });
      if (error || !data) {
        setSubmitError(error?.detail ?? 'Submission failed.');
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
      setSubmitError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Submit a solution — {PROBLEM_CODE}</h1>
      <SubmitForm onSubmit={handleSubmit} languages={LANGUAGES} busy={busy} />
      {submitError ? <p role="alert">{submitError}</p> : null}
      {submission ? <VerdictPanel submission={submission} /> : null}
    </section>
  );
}

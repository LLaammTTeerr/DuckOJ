import { useState, type FormEvent } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { api } from '../api.js';

/**
 * The three screens Phase 3f's emails point at.
 *
 * They are grouped in one file because they are one flow and share the same
 * shape — a single field, one call, one terminal message — and splitting them
 * would triplicate that shape without separating anything.
 *
 * **These close a live gap.** The reset mail already links to
 * `/reset-password?token=…` and the verification mail to
 * `/verify-email?token=…`; until this file existed, both landed on a 404 and
 * the recovery feature was unreachable from a browser.
 */

type Outcome = { kind: 'idle' } | { kind: 'done'; message: string } | { kind: 'error'; message: string };

/** Shared chrome: a heading, the form, and whatever the last attempt said. */
function Panel(props: {
  title: string;
  intro: string;
  outcome: Outcome;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
  submitLabel: string;
  busy: boolean;
  /**
   * Disabled for a reason that is not "a request is in flight" — a link that
   * arrived without a token, say. Kept separate from `busy` because folding
   * them together makes the button read "Working…" when nothing is.
   */
  disabled?: boolean;
}) {
  return (
    <section className="panel">
      <h1>{props.title}</h1>
      <p className="muted">{props.intro}</p>
      {props.outcome.kind === 'done' ? (
        <p role="status">{props.outcome.message}</p>
      ) : (
        <form onSubmit={props.onSubmit}>
          {props.children}
          {props.outcome.kind === 'error' ? <p role="alert">{props.outcome.message}</p> : null}
          <button type="submit" disabled={props.busy || (props.disabled ?? false)}>
            {props.busy ? 'Working…' : props.submitLabel}
          </button>
        </form>
      )}
      <p>
        <Link to="/">Back to sign in</Link>
      </p>
    </section>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const { error } = await api.POST('/auth/password/forgot', { body: { email } });
      // The server answers the same way whether or not the account exists, and
      // so does this screen — saying "we sent it" only for real addresses would
      // undo the whole point of that.
      setOutcome(
        error
          ? { kind: 'error', message: error.detail ?? 'That does not look like an email address.' }
          : {
              kind: 'done',
              message: 'If that address has an account, a reset link is on its way. It expires in an hour.',
            },
      );
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setOutcome({
        kind: 'error',
        message: 'Could not reach the server. Check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Reset your password"
      intro="Enter the address you signed up with."
      outcome={outcome}
      onSubmit={submit}
      submitLabel="Send reset link"
      busy={busy}
    >
      <label className="field">
        <span>Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
    </Panel>
  );
}

export function ResetPasswordPage() {
  const search = useSearch({ strict: false }) as { token?: string };
  const [password, setPassword] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const token = search.token ?? '';

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const { error } = await api.POST('/auth/password/reset', { body: { token, password } });
      setOutcome(
        error
          ? { kind: 'error', message: error.detail ?? 'That link is invalid or has expired.' }
          : {
              kind: 'done',
              message: 'Password changed. Every other session has been signed out — sign in again.',
            },
      );
    } catch {
      setOutcome({
        kind: 'error',
        message: 'Could not reach the server. Check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <section className="panel">
        <h1>Reset your password</h1>
        <p role="alert">This link is missing its token. Request a new one.</p>
        <p>
          <Link to="/forgot-password">Send another reset link</Link>
        </p>
      </section>
    );
  }

  return (
    <Panel
      title="Choose a new password"
      intro="This link works once. Signing in elsewhere will be ended."
      outcome={outcome}
      onSubmit={submit}
      submitLabel="Change password"
      busy={busy}
    >
      <label className="field">
        <span>New password</span>
        <input
          type="password"
          required
          minLength={12}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
    </Panel>
  );
}

export function VerifyEmailPage() {
  const search = useSearch({ strict: false }) as { token?: string };
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const token = search.token ?? '';

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const { error } = await api.POST('/auth/email/verify', { body: { token } });
      setOutcome(
        error
          ? { kind: 'error', message: error.detail ?? 'That link is invalid or has expired.' }
          : { kind: 'done', message: 'Address confirmed.' },
      );
    } catch {
      setOutcome({
        kind: 'error',
        message: 'Could not reach the server. Check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  // Deliberately a button rather than a request fired on mount: link
  // prefetchers and mail scanners follow URLs, and a one-time token spent by a
  // scanner is a token the user never gets to use.
  return (
    <Panel
      title="Confirm your email address"
      intro={token ? 'One click and you are done.' : 'This link is missing its token.'}
      outcome={outcome}
      onSubmit={submit}
      submitLabel="Confirm address"
      busy={busy}
      disabled={!token}
    >
      <input type="hidden" value={token} readOnly />
    </Panel>
  );
}

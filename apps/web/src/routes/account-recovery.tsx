import { useState, type FormEvent } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { api } from '../api.js';
import { useT } from '../i18n/index.js';

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
  const t = useT();
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
            {props.busy ? t('common.working') : props.submitLabel}
          </button>
        </form>
      )}
      <p>
        <Link to="/">{t('auth.backToSignIn')}</Link>
      </p>
    </section>
  );
}

export function ForgotPasswordPage() {
  const t = useT();
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
          ? { kind: 'error', message: error.detail ?? t('auth.badEmail') }
          : { kind: 'done', message: t('auth.forgotSent') },
      );
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setOutcome({
        kind: 'error',
        message: t('common.networkError'),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={t('auth.forgotTitle')}
      intro={t('auth.forgotIntro')}
      outcome={outcome}
      onSubmit={submit}
      submitLabel={t('auth.forgotSubmit')}
      busy={busy}
    >
      <label className="field">
        <span>{t('auth.emailLabel')}</span>
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
  const t = useT();
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
          ? { kind: 'error', message: error.detail ?? t('auth.linkInvalid') }
          : { kind: 'done', message: t('auth.resetDone') },
      );
    } catch {
      setOutcome({
        kind: 'error',
        message: t('common.networkError'),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <section className="panel">
        <h1>{t('auth.forgotTitle')}</h1>
        <p role="alert">{t('auth.tokenMissing')}</p>
        <p>
          <Link to="/forgot-password">{t('auth.sendAnotherLink')}</Link>
        </p>
      </section>
    );
  }

  return (
    <Panel
      title={t('auth.resetTitle')}
      intro={t('auth.resetIntro')}
      outcome={outcome}
      onSubmit={submit}
      submitLabel={t('auth.resetSubmit')}
      busy={busy}
    >
      <label className="field">
        <span>{t('auth.newPassword')}</span>
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
  const t = useT();
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
          ? { kind: 'error', message: error.detail ?? t('auth.linkInvalid') }
          : { kind: 'done', message: t('auth.verifyDone') },
      );
    } catch {
      setOutcome({
        kind: 'error',
        message: t('common.networkError'),
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
      title={t('auth.verifyTitle')}
      intro={token ? t('auth.verifyIntro') : t('auth.verifyIntroNoToken')}
      outcome={outcome}
      onSubmit={submit}
      submitLabel={t('auth.verifySubmit')}
      busy={busy}
      disabled={!token}
    >
      <input type="hidden" value={token} readOnly />
    </Panel>
  );
}

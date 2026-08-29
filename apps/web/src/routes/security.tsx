/**
 * `/account/security` — enrol, and un-enrol, the TOTP second factor.
 *
 * The three routes behind this screen have existed since Phase 3a and had no
 * UI at all: 2FA could be turned on only by calling the API by hand, which in
 * practice meant nobody had it on. `login.tsx` has always handled the
 * challenge side (`totp_required` → the second-step input, wired in
 * `router.tsx`'s `useAuthGate`), so this screen closes the other half.
 *
 * Session-only server-side, like `/account/tokens` beside it: a personal
 * access token cannot manage the credentials that mint sessions, and the API
 * answers 403 `session_required` if one tries. This page reports that the same
 * way the tokens page does rather than pretending the buttons might work.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';
import { QrCode } from '../qr.js';

/** Exactly what `POST /auth/totp/begin` answers with. */
interface Enrolment {
  secret: string;
  otpauthUrl: string;
}

/**
 * RFC 6238 codes are six digits. Checked here so the obvious typo never costs
 * a round trip — the server validates independently (422
 * `invalid_totp_enrolment_code`), and this is a convenience, not the guard.
 */
const CODE_PATTERN = /^\d{6}$/;

export function SecurityPage() {
  const client = useQueryClient();
  // The same `['me']` entry the nav and every other screen read: `totpEnabled`
  // rides on `GET /auth/me`, so enrolling has to invalidate it rather than
  // keep a second copy of the answer that the shell would contradict.
  const me = useQuery(meQueryOptions);

  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  // One flag across begin/confirm/disable. `begin` in particular is
  // destructive on repeat — the endpoint upserts a FRESH secret and clears
  // `confirmedAt`, so a double click hands the viewer a QR for secret A while
  // the server has already moved on to secret B.
  const [busy, setBusy] = useState(false);

  async function begin(): Promise<void> {
    setBusy(true);
    try {
      const { data, error: err } = await api.POST('/auth/totp/begin');
      if (err) {
        setError(err.detail ?? 'Could not start enrolment.');
        return;
      }
      setError(null);
      setCode('');
      setEnrolment(data);
    } catch {
      // openapi-fetch resolves HTTP errors to `{ error }` but RETHROWS
      // network-level failures — see submit.tsx's handleSubmit.
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      const { error: err } = await api.POST('/auth/totp/confirm', { body: { code } });
      if (err) {
        // Deliberately keeps `enrolment` on screen. The server's pending
        // secret is untouched by a rejected code, so clearing it here would
        // make the viewer re-scan a QR that is still perfectly valid — and
        // a wrong code is usually a clock drift or a fat finger, retried in
        // thirty seconds.
        setError(err.detail ?? 'That code is not valid.');
        return;
      }
      setError(null);
      setEnrolment(null);
      setCode('');
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    // Turning off the second factor is not undoable without re-enrolling every
    // authenticator, so it asks — the same `confirm()` gate the admin screens
    // use for their destructive actions.
    if (!window.confirm('Turn off two-factor authentication for this account?')) return;
    setBusy(true);
    try {
      const { error: err } = await api.DELETE('/auth/totp');
      if (err) {
        setError(err.detail ?? 'Could not disable two-factor authentication.');
        return;
      }
      setError(null);
      setEnrolment(null);
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (me.isPending) return <p className="muted">Loading…</p>;
  // `GET /auth/me` answers 401 signed-out, which `fetchMe` maps to null. A
  // token-authed viewer gets a user back but cannot use any button here, so
  // the message names the session requirement either way.
  if (me.data == null) {
    return <p>Sign in (with a session, not a token) to manage two-factor authentication.</p>;
  }
  const enabled = me.data.totpEnabled;

  return (
    <section className="panel">
      <h1>Security</h1>
      <p className="muted">
        A second factor: a six-digit code from an authenticator app, on top of your password.
      </p>

      <p role="status">
        {enabled
          ? 'Two-factor authentication is on for this account.'
          : 'Two-factor authentication is not enabled.'}
      </p>
      {error ? <p role="alert">{error}</p> : null}

      {enabled ? (
        <p>
          <button type="button" disabled={busy} onClick={() => void disable()}>
            Disable two-factor authentication
          </button>
        </p>
      ) : enrolment === null ? (
        <p>
          <button type="button" disabled={busy} onClick={() => void begin()}>
            Enable
          </button>
        </p>
      ) : (
        <>
          <h2>Scan this</h2>
          <p className="muted">
            Add it to your authenticator app — scan the code, or type the secret in by hand.
          </p>
          {/* The QR renders entirely client-side. The secret is IN this URL,
              so handing it to an external chart service to draw would leak
              the one thing the second factor exists to protect. */}
          <p>
            <QrCode value={enrolment.otpauthUrl} />
          </p>
          <p>
            Secret: <code>{enrolment.secret}</code>
          </p>

          <h2>Confirm</h2>
          <p className="muted">
            Enrolment is not finished until a code from the app is accepted — until then this
            account still signs in with a password alone.
          </p>
          <p>
            <label htmlFor="totp-code">Six-digit code </label>
            <input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
            />
          </p>
          <p>
            <button
              type="button"
              disabled={busy || !CODE_PATTERN.test(code)}
              onClick={() => void confirm()}
            >
              Confirm
            </button>{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEnrolment(null);
                setCode('');
                setError(null);
              }}
            >
              Cancel
            </button>
          </p>
        </>
      )}
    </section>
  );
}

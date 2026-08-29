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
import { useT } from '../i18n/index.js';

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
  const t = useT();
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
        setError(err.detail ?? t('security.beginError'));
        return;
      }
      setError(null);
      setCode('');
      setEnrolment(data);
    } catch {
      // openapi-fetch resolves HTTP errors to `{ error }` but RETHROWS
      // network-level failures — see submit.tsx's handleSubmit.
      setError(t('common.networkError'));
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
        setError(err.detail ?? t('security.badCode'));
        return;
      }
      setError(null);
      setEnrolment(null);
      setCode('');
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    // Turning off the second factor is not undoable without re-enrolling every
    // authenticator, so it asks — the same `confirm()` gate the admin screens
    // use for their destructive actions.
    if (!window.confirm(t('security.confirmDisable'))) return;
    setBusy(true);
    try {
      const { error: err } = await api.DELETE('/auth/totp');
      if (err) {
        setError(err.detail ?? t('security.disableError'));
        return;
      }
      setError(null);
      setEnrolment(null);
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  if (me.isPending) return <p className="muted">{t('common.loading')}</p>;
  // `GET /auth/me` answers 401 signed-out, which `fetchMe` maps to null. A
  // token-authed viewer gets a user back but cannot use any button here, so
  // the message names the session requirement either way.
  if (me.data == null) {
    return <p>{t('security.gate')}</p>;
  }
  const enabled = me.data.totpEnabled;

  return (
    <section className="panel">
      <h1>{t('security.title')}</h1>
      <p className="muted">{t('security.intro')}</p>

      <p role="status">{enabled ? t('security.on') : t('security.off')}</p>
      {error ? <p role="alert">{error}</p> : null}

      {enabled ? (
        <p>
          <button type="button" disabled={busy} onClick={() => void disable()}>
            {t('security.disable')}
          </button>
        </p>
      ) : enrolment === null ? (
        <p>
          <button type="button" disabled={busy} onClick={() => void begin()}>
            {t('security.enable')}
          </button>
        </p>
      ) : (
        <>
          <h2>{t('security.scanThis')}</h2>
          <p className="muted">{t('security.scanNote')}</p>
          {/* The QR renders entirely client-side. The secret is IN this URL,
              so handing it to an external chart service to draw would leak
              the one thing the second factor exists to protect. */}
          <p>
            <QrCode value={enrolment.otpauthUrl} />
          </p>
          <p>
            {t('security.secret')}
            <code>{enrolment.secret}</code>
          </p>

          <h2>{t('security.confirm')}</h2>
          <p className="muted">{t('security.confirmNote')}</p>
          <p>
            <label htmlFor="totp-code">{t('security.codeLabel')}</label>
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
              {t('security.confirm')}
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
              {t('common.cancel')}
            </button>
          </p>
        </>
      )}
    </section>
  );
}

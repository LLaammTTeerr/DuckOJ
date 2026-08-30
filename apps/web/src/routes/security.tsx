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
  /**
   * D39 — the recovery codes, held only for as long as this screen is open.
   *
   * They exist nowhere else: the server keeps hashes, so nothing can put them
   * back on screen once this state is cleared. That is why the panel below
   * takes over the whole screen and its only exit is the acknowledgement — a
   * viewer who navigates away from a half-read list has genuinely lost them.
   */
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  /** D72 — the account password, presented to turn the second factor off. */
  const [disablePassword, setDisablePassword] = useState('');
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
      const { data, error: err } = await api.POST('/auth/totp/confirm', { body: { code } });
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
      setCopied(false);
      setCodes(data?.recoveryCodes ?? []);
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * D39 — a fresh set, proved with a live code from the authenticator. The
   * response is handled exactly like `confirm`'s, because it is the same
   * once-only delivery.
   */
  async function regenerate(): Promise<void> {
    setBusy(true);
    try {
      const { data, error: err } = await api.POST('/auth/totp/recovery/regenerate', {
        body: { code },
      });
      if (err) {
        setError(err.detail ?? t('security.recoveryRegenerateError'));
        return;
      }
      setError(null);
      setCode('');
      setCopied(false);
      setRegenerating(false);
      setCodes(data?.recoveryCodes ?? []);
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  async function copyCodes(): Promise<void> {
    try {
      // `navigator.clipboard` is absent over plain HTTP and in some embedded
      // browsers. The codes are on screen either way, so this is a
      // convenience that must never look like a failure to produce them.
      await navigator.clipboard.writeText((codes ?? []).join('\n'));
      setCopied(true);
    } catch {
      setError(t('security.recoveryCopyError'));
    }
  }

  async function disable(): Promise<void> {
    // D72 — the password replaces the old `confirm()` dialog rather than
    // joining it: a dialog proves the click was deliberate, and this route
    // needs proof of WHO is clicking. A stolen session has the click.
    setBusy(true);
    try {
      const { error: err } = await api.DELETE('/auth/totp', {
        body: { password: disablePassword },
      });
      if (err) {
        setError(err.detail ?? t('security.disableError'));
        return;
      }
      setError(null);
      setEnrolment(null);
      setDisablePassword('');
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
  const remaining = me.data.recoveryCodesRemaining;

  return (
    <section className="panel">
      <h1>{t('security.title')}</h1>
      <p className="muted">{t('security.intro')}</p>

      <p role="status">{enabled ? t('security.on') : t('security.off')}</p>
      {error ? <p role="alert">{error}</p> : null}

      {/* The codes take the whole screen, ahead of every other branch. They
          are on screen exactly once and there is no second chance to read
          them, so nothing else may compete for the reader's attention while
          they are — including the Disable button, which would be a very
          expensive misclick here. */}
      {codes !== null ? (
        <>
          <h2>{t('security.recoveryTitle')}</h2>
          <p role="alert">{t('security.recoveryShownOnce')}</p>
          {/* A `<pre>`, not a list: it selects, copies and PRINTS as the plain
              block of text somebody is going to fold into a wallet. */}
          <pre>{codes.join('\n')}</pre>
          <p>
            <button type="button" onClick={() => void copyCodes()}>
              {t('security.recoveryCopy')}
            </button>{' '}
            {/* A live region so a screen reader announces the copy worked;
                without it the confirmation was a silent visual-only change
                (WCAG 4.1.3). Rendered on copy rather than always-present so
                it does not add a second empty status to the codes screen —
                a role="status" subtree inserted with its text is announced.
                (loop-b20 a11y) */}
            {copied ? (
              <span role="status" className="muted">
                {t('security.recoveryCopied')}
              </span>
            ) : null}
          </p>
          <p>
            <button
              type="button"
              onClick={() => {
                setCodes(null);
                setCopied(false);
              }}
            >
              {t('security.recoverySaved')}
            </button>
          </p>
        </>
      ) : enabled ? (
        <>
          <p>
            {remaining === 0
              ? t('security.recoveryNoneLeft')
              : t('security.recoveryRemaining', { n: remaining })}
          </p>
          {regenerating ? (
            <>
              <p className="muted">{t('security.recoveryRegenerateNote')}</p>
              <p>
                <label htmlFor="regen-code">{t('security.codeLabel')}</label>
                <input
                  id="regen-code"
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
                  onClick={() => void regenerate()}
                >
                  {t('security.recoveryRegenerate')}
                </button>{' '}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRegenerating(false);
                    setCode('');
                    setError(null);
                  }}
                >
                  {t('common.cancel')}
                </button>
              </p>
            </>
          ) : (
            <p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRegenerating(true);
                  setCode('');
                  setError(null);
                }}
              >
                {t('security.recoveryRegenerate')}
              </button>
            </p>
          )}
          <p>
            <label htmlFor="totp-disable-password">{t('security.disablePassword')}</label>{' '}
            <input
              id="totp-disable-password"
              type="password"
              autoComplete="current-password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
            />{' '}
            <button
              type="button"
              disabled={busy || disablePassword === ''}
              onClick={() => void disable()}
            >
              {t('security.disable')}
            </button>
          </p>
          <p className="muted">{t('security.disableNote')}</p>
        </>
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
          {/* Said BEFORE the button, not after: "an admin reset is the only
              way back" is the fact that decides whether someone should turn
              this on at all, and it is worthless as an explanation of what
              already happened. */}
          <p role="note">{t('security.enrolWarning')}</p>
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

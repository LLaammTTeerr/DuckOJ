import { useState, type FormEvent } from 'react';
import { useT } from '../i18n/index.js';

export interface LoginValues {
  usernameOrEmail: string;
  password: string;
  totpCode: string | undefined;
  /**
   * D39 — the alternative second factor, for someone whose authenticator is
   * gone. Never sent alongside `totpCode`: the toggle below picks one, and
   * the server would ignore the recovery code anyway (a TOTP code wins), so
   * sending both would quietly do nothing while looking like it might.
   */
  recoveryCode: string | undefined;
}

export function LoginForm(props: {
  onSubmit: (values: LoginValues) => Promise<void>;
  error: string | null;
  needsTotp?: boolean;
}) {
  const t = useT();
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    void props.onSubmit({
      usernameOrEmail,
      password,
      totpCode: useRecovery || totpCode === '' ? undefined : totpCode,
      recoveryCode: !useRecovery || recoveryCode === '' ? undefined : recoveryCode,
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      {props.error ? <p role="alert">{props.error}</p> : null}
      <label htmlFor="identifier">{t('auth.usernameOrEmail')}</label>
      <input
        id="identifier"
        value={usernameOrEmail}
        onChange={(e) => setUsernameOrEmail(e.target.value)}
      />
      <label htmlFor="password">{t('auth.password')}</label>
      <input
        id="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {/* The second step only. The toggle is deliberately NOT on the first
          screen: a recovery code is the exceptional path, and offering it to
          everyone at every sign-in is how people burn them for no reason. */}
      {props.needsTotp ? (
        useRecovery ? (
          <>
            <label htmlFor="recovery">{t('auth.recoveryCode')}</label>
            <input
              id="recovery"
              autoComplete="one-time-code"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
            />
            <p className="muted">{t('auth.recoveryCodeNote')}</p>
            <button type="button" onClick={() => setUseRecovery(false)}>
              {t('auth.useTotpCode')}
            </button>
          </>
        ) : (
          <>
            <label htmlFor="totp">{t('auth.totpCode')}</label>
            <input
              id="totp"
              inputMode="numeric"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
            />
            <button type="button" onClick={() => setUseRecovery(true)}>
              {t('auth.useRecoveryCode')}
            </button>
          </>
        )
      ) : null}
      <button type="submit">{t('auth.signIn')}</button>
    </form>
  );
}

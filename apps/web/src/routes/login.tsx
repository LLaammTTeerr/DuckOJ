import { useState, type FormEvent } from 'react';
import { useT } from '../i18n/index.js';

export interface LoginValues {
  usernameOrEmail: string;
  password: string;
  totpCode: string | undefined;
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

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    void props.onSubmit({
      usernameOrEmail,
      password,
      totpCode: totpCode === '' ? undefined : totpCode,
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
      {props.needsTotp ? (
        <>
          <label htmlFor="totp">{t('auth.totpCode')}</label>
          <input id="totp" inputMode="numeric" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
        </>
      ) : null}
      <button type="submit">{t('auth.signIn')}</button>
    </form>
  );
}

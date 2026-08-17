import { useState, type FormEvent } from 'react';

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
      <label htmlFor="identifier">Username or email</label>
      <input
        id="identifier"
        value={usernameOrEmail}
        onChange={(e) => setUsernameOrEmail(e.target.value)}
      />
      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {props.needsTotp ? (
        <>
          <label htmlFor="totp">Two-factor code</label>
          <input id="totp" inputMode="numeric" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
        </>
      ) : null}
      <button type="submit">Sign in</button>
    </form>
  );
}

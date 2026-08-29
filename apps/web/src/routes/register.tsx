/**
 * `/register` — the screen that did not exist. Until this file, the only way
 * to get a DuckOJ account was to `POST /auth/register` by hand: the sign-in
 * form was the whole of the front door, and it had no other side.
 *
 * Two things about the endpoint shape this page:
 *
 *  - `POST /auth/register` answers 201 with the user and **no session
 *    cookie** — only `POST /auth/login` takes a `@Res`. So a successful
 *    signup is two calls, not one, and the second one is what actually ends
 *    with the visitor signed in. If it fails (a race against a password
 *    change, a rate limit) the account still exists, so the page says so and
 *    stays put rather than sending them to `/` signed out.
 *  - the verification mail is best-effort in the controller (a mailer outage
 *    must not turn a created account into a 500), so the note below promises
 *    a link is on its way and gates nothing on it.
 *
 * Validation mirrors `packages/contracts/src/auth.ts`'s `RegisterRequest`
 * clause for clause, in the active locale, and runs before any request is
 * sent — the server's own 422 carries no field attribution a form could use.
 * The one rule that is NOT the contract's is `confirm`: the contract has no
 * such field, because confirming a password is a typo guard for humans, not
 * a property of the account being created.
 */
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { api } from '../api.js';
import { useT, type TFunction } from '../i18n/index.js';

/** The five inputs, keyed the way `fieldErrors` and the DOM ids are. */
type Field = 'username' | 'email' | 'displayName' | 'password' | 'confirm';

type Values = Record<Field, string>;

const EMPTY: Values = { username: '', email: '', displayName: '', password: '', confirm: '' };

/**
 * `Username`'s regex, copied from the contract verbatim rather than
 * approximated: a client rule that is merely *similar* to the server's
 * rejects addresses the server would have taken, which is worse than not
 * checking at all.
 */
const USERNAME_CHARS = /^[A-Za-z0-9_.-]+$/;
/**
 * Deliberately laxer than any RFC and laxer than zod's own `.email()`: this
 * is a typo guard, and the server's `z.string().email()` remains the
 * authority. Refusing something zod would accept is the only failure mode
 * that costs a real user an account.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The contract's rules, in the active locale. Returns the fields that failed,
 * in no particular order — every one of them is shown at once, because a form
 * that reveals its objections one round trip at a time is a form people
 * abandon.
 */
export function validateRegistration(values: Values, t: TFunction): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (values.username.length < 3 || values.username.length > 32) {
    errors.username = t('auth.errUsernameLength');
  } else if (!USERNAME_CHARS.test(values.username)) {
    errors.username = t('auth.errUsernameChars');
  }
  if (!LOOKS_LIKE_EMAIL.test(values.email)) {
    errors.email = t('auth.errEmail');
  }
  if (values.displayName.length < 1 || values.displayName.length > 64) {
    errors.displayName = t('auth.errDisplayName');
  }
  // `Password = z.string().min(10)`. NOT 12 — that is `ResetPasswordRequest`'s
  // own, stricter rule, and copying it here would refuse an eleven-character
  // password the register endpoint accepts.
  if (values.password.length < 10 || values.password.length > 256) {
    errors.password = t('auth.errPasswordLength');
  } else if (values.confirm !== values.password) {
    errors.confirm = t('auth.errPasswordMismatch');
  }
  return errors;
}

/** Which field a server refusal is about, if it is about one at all. */
function fieldForCode(code: string | undefined): Field | null {
  if (code === 'username_taken') return 'username';
  if (code === 'email_taken') return 'email';
  return null;
}

/**
 * One labelled input plus its own error, wired with `aria-describedby` so a
 * screen reader reads the objection as part of the field rather than as a
 * stray paragraph somewhere on the page.
 */
function TextField(props: {
  id: Field;
  label: string;
  type?: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const errorId = `${props.id}-error`;
  // The `<label>` deliberately does NOT wrap the input the way
  // `account-recovery.tsx`'s fields do: a wrapping label folds the error
  // text into the field's own accessible NAME, so "Mật khẩu" would read as
  // "Mật khẩu Ít nhất 10 ký tự" the moment it went wrong — and every
  // `getByLabelText` for it, including the ones a user's screen reader
  // performs by voice, would stop matching. Referenced by `htmlFor`, the
  // objection is the field's accessible DESCRIPTION instead, which is what
  // it is.
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? errorId : undefined}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.error ? (
        <span id={errorId} className="muted">
          {props.error}
        </span>
      ) : null}
    </div>
  );
}

export function RegisterPage() {
  const t = useT();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [values, setValues] = useState<Values>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set(field: Field): (value: string) => void {
    return (value: string) => {
      setValues((current) => ({ ...current, [field]: value }));
    };
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const invalid = validateRegistration(values, t);
    setFieldErrors(invalid);
    setError(null);
    if (Object.keys(invalid).length > 0) return;

    setBusy(true);
    try {
      const created = await api.POST('/auth/register', {
        body: {
          username: values.username,
          email: values.email,
          displayName: values.displayName,
          password: values.password,
        },
      });
      if (created.error) {
        const field = fieldForCode(created.error.code);
        // The server's `detail` is its own wording and is shown verbatim —
        // it is not in either catalogue, by design (see i18n/en.ts).
        const message = created.error.detail ?? t('auth.registerFailed');
        if (field) setFieldErrors({ [field]: message });
        else setError(message);
        return;
      }

      // The account exists from here on. Everything below can fail without
      // un-creating it, which is why none of it navigates away on failure.
      const signedIn = await api.POST('/auth/login', {
        body: { usernameOrEmail: values.username, password: values.password },
      });
      if (signedIn.error) {
        setError(signedIn.error.detail ?? t('auth.signInFailed'));
        return;
      }
      await client.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    } catch {
      // openapi-fetch resolves HTTP errors to `{ error }` but RETHROWS
      // network-level failures — same catch every write on this app carries.
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h1>{t('auth.registerTitle')}</h1>
      <p className="muted">{t('auth.registerIntro')}</p>
      {/* Standing copy, NOT a `role="status"` raised after a successful
          signup: this page navigates to `/` the moment the chained sign-in
          returns, so a note rendered on success would unmount before anyone
          could read it — and on the one path where it survived (the sign-in
          after registration failing) it would sit beside the failure saying
          the opposite. Told up front, in the future tense, it is true at the
          moment it is read. The mail itself is best-effort in the controller,
          so nothing here waits on it. */}
      <p className="muted">{t('auth.verificationSent')}</p>
      {/* `noValidate`: the email field keeps `type="email"` for the mobile
          keyboard it summons, but the browser's own constraint validation
          would otherwise swallow the submit and answer with a bubble in the
          BROWSER's language, not the one this app is set to. Validation is
          `validateRegistration`'s job, in the active locale, beside the
          field. */}
      <form noValidate onSubmit={(event) => void handleSubmit(event)}>
        <TextField
          id="username"
          label={t('common.username')}
          value={values.username}
          error={fieldErrors.username}
          onChange={set('username')}
        />
        <TextField
          id="email"
          label={t('auth.emailLabel')}
          type="email"
          value={values.email}
          error={fieldErrors.email}
          onChange={set('email')}
        />
        <TextField
          id="displayName"
          label={t('auth.displayName')}
          value={values.displayName}
          error={fieldErrors.displayName}
          onChange={set('displayName')}
        />
        <TextField
          id="password"
          label={t('auth.password')}
          type="password"
          value={values.password}
          error={fieldErrors.password}
          onChange={set('password')}
        />
        <TextField
          id="confirm"
          label={t('auth.confirmPassword')}
          type="password"
          value={values.confirm}
          error={fieldErrors.confirm}
          onChange={set('confirm')}
        />
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={busy}>
          {busy ? t('common.working') : t('auth.registerSubmit')}
        </button>
      </form>
      <p className="muted">
        <Link to="/">{t('auth.haveAccount')}</Link>
      </p>
    </section>
  );
}

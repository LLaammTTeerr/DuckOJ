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
import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { api } from '../api.js';
import { dropDepartingViewerCache } from '../me.js';
import { useT, type TFunction } from '../i18n/index.js';
import { ErrorSummary, mapFieldErrors } from '../forms.js';

/** The five inputs, keyed the way `fieldErrors` and the DOM ids are. */
type Field = 'username' | 'email' | 'displayName' | 'password' | 'confirm';

type Values = Record<Field, string>;

const EMPTY: Values = { username: '', email: '', displayName: '', password: '', confirm: '' };

/**
 * The fields in the order they appear on screen, so the error summary lists
 * its links top-to-bottom the way a reader tabs through the form rather than
 * in whatever order `fieldErrors`' keys happen to iterate.
 */
const FIELD_ORDER: readonly Field[] = ['username', 'email', 'displayName', 'password', 'confirm'];

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

/**
 * Which field a server refusal is about, if it is about one at all.
 *
 * `email_taken` is deliberately absent (D26): the API no longer emits it — a
 * taken address is answered as a success — and routing it to the email field
 * is exactly the rendering that made this page an enumeration oracle. Any
 * future code that reappears here goes to the banner instead of being guessed
 * onto a field.
 */
function fieldForCode(code: string | undefined): Field | null {
  if (code === 'username_taken') return 'username';
  return null;
}

/**
 * `RegisterRequest`'s own keys → this form's fields (D146).
 *
 * The client rules above are deliberately laxer than zod's in two places
 * (`LOOKS_LIKE_EMAIL`, and the username regex is the contract's but the
 * server may tighten), so a 422 CAN still come back on a form this page
 * thought was clean — and it used to arrive as one English banner with no
 * field named.
 *
 * `email` is in this map and does not reopen D26: a 422 `validation_failed`
 * is the pipe objecting to the SHAPE of the address, and says nothing about
 * whether an account with it exists. `email_taken` remains absent from
 * `fieldForCode`, which is where the enumeration oracle actually lived.
 * `confirm` is not here because the contract has no such field.
 */
const SERVER_FIELDS: Readonly<Partial<Record<string, Field>>> = {
  username: 'username',
  email: 'email',
  displayName: 'displayName',
  password: 'password',
};

/**
 * One labelled input plus its own error, wired with `aria-describedby` so a
 * screen reader reads the objection as part of the field rather than as a
 * stray paragraph somewhere on the page.
 */
function TextField(props: {
  id: Field;
  label: string;
  type?: string;
  autoComplete?: string;
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
        autoComplete={props.autoComplete}
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
  /**
   * The account this page has already created, if any (final review m20).
   *
   * Everything after `POST /auth/register` can fail on its own — the chained
   * sign-in meets D16's login meter, or a transient 500 — and the account
   * still exists. Without this, clicking the button again re-POSTs the
   * registration, the server answers `username_taken`, and the page tells the
   * user the name they were handed thirty seconds ago is somebody else's.
   *
   * A ref, not state: it is read inside the very handler that writes it and
   * must never schedule a render. It remembers the CREDENTIALS, not a
   * boolean, so editing the username (or the password) before retrying
   * correctly registers again — the remembered account is not the one that
   * submission is about.
   */
  const registered = useRef<{ username: string; password: string } | null>(null);

  /**
   * The error summary lives in `src/forms.tsx` now — D110's pattern was built
   * here and stayed here for eleven other forms that needed it. `submitCount`
   * is still this page's, because only this page knows when an attempt was
   * made; the focus behaviour it drives is the component's.
   */
  const [submitCount, setSubmitCount] = useState(0);

  function set(field: Field): (value: string) => void {
    return (value: string) => {
      setValues((current) => ({ ...current, [field]: value }));
    };
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    // Bumped on every attempt so the summary re-takes focus even when the
    // same fields fail twice in a row (see `summaryRef`'s effect).
    setSubmitCount((count) => count + 1);
    const invalid = validateRegistration(values, t);
    setFieldErrors(invalid);
    setError(null);
    if (Object.keys(invalid).length > 0) return;

    setBusy(true);
    try {
      const alreadyCreated =
        registered.current?.username === values.username &&
        registered.current.password === values.password;
      if (!alreadyCreated) {
        const created = await api.POST('/auth/register', {
          body: {
            username: values.username,
            email: values.email,
            displayName: values.displayName,
            password: values.password,
          },
        });
        if (created.error) {
          // D146 first: a 422 names the fields itself, and the server's own
          // attribution beats anything this page could infer from a code.
          const attributed = mapFieldErrors(created.error.fields, SERVER_FIELDS);
          if (Object.keys(attributed).length > 0) {
            setFieldErrors(attributed);
            return;
          }
          const field = fieldForCode(created.error.code);
          // The server's `detail` is its own wording and is shown verbatim —
          // it is not in either catalogue, by design (see i18n/en.ts).
          const message = created.error.detail ?? t('auth.registerFailed');
          if (field) setFieldErrors({ [field]: message });
          else setError(message);
          return;
        }
        registered.current = { username: values.username, password: values.password };
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
      // B-34 — the same swap `useAuthGate` performs, for the same reason: a
      // brand-new account must not inherit whatever the tab was holding for
      // whoever used it last. Before `['me']`, so nothing renders the new
      // viewer over the old viewer's answers.
      dropDepartingViewerCache(client);
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
        {/* The Focusable Error Summary (WCAG 3.3.1 + guideline). It
            complements the inline per-field errors, never replaces them: it
            is `role="alert"` so a failed submit is announced, `tabIndex={-1}`
            so focus can be moved onto it, and each item is a link that puts
            focus on the field it names — a keyboard reader lands on the list
            of problems and steps straight to the first one. `#${id}` is a
            real fragment for a pointer, and the click handler carries the
            focus that a hash href does not move on its own. */}
        {/* The Focusable Error Summary (WCAG 3.3.1 + guideline), now
            `src/forms.tsx`'s. It COMPLEMENTS the inline per-field errors,
            never replaces them: a reader gets the overview and the per-field
            objection both. */}
        <ErrorSummary errors={fieldErrors} order={FIELD_ORDER} attempt={submitCount} />
        <TextField
          id="username"
          label={t('common.username')}
          autoComplete="username"
          value={values.username}
          error={fieldErrors.username}
          onChange={set('username')}
        />
        <TextField
          id="email"
          label={t('auth.emailLabel')}
          type="email"
          autoComplete="email"
          value={values.email}
          error={fieldErrors.email}
          onChange={set('email')}
        />
        <TextField
          id="displayName"
          label={t('auth.displayName')}
          autoComplete="name"
          value={values.displayName}
          error={fieldErrors.displayName}
          onChange={set('displayName')}
        />
        <TextField
          id="password"
          label={t('auth.password')}
          type="password"
          autoComplete="new-password"
          value={values.password}
          error={fieldErrors.password}
          onChange={set('password')}
        />
        <TextField
          id="confirm"
          label={t('auth.confirmPassword')}
          type="password"
          autoComplete="new-password"
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

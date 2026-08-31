/**
 * `/account/password` — change your own password, and the gate that forces it
 * (D61).
 *
 * Two things live here because they are the same screen twice. An ordinary
 * reader arrives by choice and must produce their current password; a pupil
 * whose account came off a school's roster import arrives because
 * `mustChangePassword` is set, has no current password of their own to
 * produce, and is not allowed anywhere else until they have chosen one. The
 * server enforces the second half of that (it refuses to accept a change
 * without the old password once the flag is clear); this file is what makes
 * the obligation visible instead of a 422 nobody can act on.
 *
 * `PasswordGate` is exported separately from the route component so it can be
 * tested without the route tree, and so `router.tsx` can wrap `<Outlet />`
 * with it in one place rather than every route remembering to ask.
 */
import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';
import { useT } from '../i18n/index.js';
import { ErrorSummary, FieldError, fieldProps } from '../forms.js';

/** `Password` in `@duckoj/contracts` — restated so the form can refuse early. */
const MIN_PASSWORD_LENGTH = 10;

/** The three inputs, keyed the way `fieldErrors` and the DOM ids are. */
type Field = 'current' | 'next' | 'confirm';
const FIELD_ORDER: readonly Field[] = ['current', 'next', 'confirm'];

export function ChangePasswordPage({
  forced = false,
  onChanged,
}: {
  forced?: boolean;
  /**
   * Called once the change has been accepted, BEFORE the `me` refetch below.
   *
   * The forced instance of this page is rendered by `PasswordGate`, and the
   * refetch is what makes the gate step aside — unmounting this component in
   * the same tick the change succeeds. So the confirmation cannot live here:
   * `done` below is raised and destroyed together, and a pupil sees the form
   * vanish and the site appear with nothing anywhere saying their password
   * changed. This hands the news to something that outlives the swap.
   */
  onChanged?: () => void;
}) {
  const t = useT();
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The objections, raised on BLUR or on submit and never while typing.
   *
   * This form used to compute them live: "Ngắn hơn 10 ký tự." appeared on the
   * first character of a twelve-character password and stayed for nine more,
   * and the mismatch line sat under the confirm box for the whole time it was
   * being typed. An objection that is true only because the reader has not
   * finished is not teaching them anything — and this is the one form every
   * roster-imported pupil (D61) must get through before they may see the site
   * at all.
   */
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [attempt, setAttempt] = useState(0);
  /**
   * Whether the SUMMARY is showing — which is not the same question as
   * whether there are field errors.
   *
   * D110's summary takes focus when it appears, and that is right for a
   * failed submit and catastrophic for a blur: tabbing out of the new-password
   * box would rip focus off the confirm box the reader had just tabbed INTO.
   * So a blur raises the field's own objection and nothing else; only a press
   * raises the overview.
   */
  const [showSummary, setShowSummary] = useState(false);

  // The flag on the account decides, not the prop: a reader who lands on this
  // URL directly while flagged must get the same form the gate would have
  // shown them, and one whose flag was cleared in another tab must not be
  // offered a shortcut that no longer works.
  const mustChange = forced || me.data?.mustChangePassword === true;
  /**
   * The contract's rules, in the active locale. `mustChange` decides whether
   * the current password is asked for at all — a pupil off a roster import
   * has none of their own to produce.
   */
  function validate(): Partial<Record<Field, string>> {
    const invalid: Partial<Record<Field, string>> = {};
    if (!mustChange && current.length === 0) invalid.current = t('form.required');
    if (next.length < MIN_PASSWORD_LENGTH) invalid.next = t('password.tooShort', { n: MIN_PASSWORD_LENGTH });
    else if (confirm !== next) invalid.confirm = t('password.mismatch');
    return invalid;
  }

  /**
   * One field, checked because the reader has LEFT it — the moment they have
   * actually finished with it, which is the earliest an objection about it can
   * be true. Only ever raises or clears that one field's own error, so
   * blurring the new-password box cannot put a complaint under a confirm box
   * nobody has reached yet.
   */
  function checkOnBlur(field: Field): () => void {
    return () => {
      setShowSummary(false);
      const invalid = validate();
      setFieldErrors((current_) => {
        const nextErrors = { ...current_ };
        if (invalid[field] === undefined) delete nextErrors[field];
        else nextErrors[field] = invalid[field];
        return nextErrors;
      });
    };
  }

  async function save(): Promise<void> {
    if (busy) return;
    // Bumped on every attempt so the summary re-takes focus even when the
    // same fields fail twice in a row (D110).
    setAttempt((n) => n + 1);
    const invalid = validate();
    setFieldErrors(invalid);
    setShowSummary(true);
    setError(null);
    if (Object.keys(invalid).length > 0) return;
    setBusy(true);
    try {
      const { error: err } = await api.POST('/auth/password/change', {
        body: mustChange ? { newPassword: next } : { currentPassword: current, newPassword: next },
      });
      if (err) {
        setError(err.detail ?? t('password.error'));
        return;
      }
      setError(null);
      setDone(true);
      setFieldErrors({});
      setShowSummary(false);
      setCurrent('');
      setNext('');
      setConfirm('');
      // Before the refetch, not after: the refetch is what unmounts this
      // component when the gate steps aside, and a `setState` on the way out
      // would be dropped.
      onChanged?.();
      // The obligation is carried on `me`, so the gate keeps standing until
      // this refetch lands. Nothing else can clear it.
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch {
      setError(t('password.error'));
    } finally {
      setBusy(false);
    }
  }

  if (me.data == null && !forced) return <p className="muted">{t('password.signedOut')}</p>;

  return (
    <section className="panel">
      <h1>{t('password.title')}</h1>
      {mustChange ? <p role="alert">{t('password.forced')}</p> : null}
      {done ? <p role="status">{t('password.done')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {/* D110's Focusable Error Summary, reused rather than reinvented: a
          pupil who pressed the button on an incomplete form is told so, and
          focus lands on the list of what is missing. */}
      <ErrorSummary errors={showSummary ? fieldErrors : {}} order={FIELD_ORDER} attempt={attempt} />
      {mustChange ? null : (
        <p>
          <label>
            {t('password.current')}{' '}
            <input
              {...fieldProps('current', fieldErrors.current)}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              onBlur={checkOnBlur('current')}
            />
          </label>
          <FieldError id="current" message={fieldErrors.current} />
        </p>
      )}
      <p>
        <label>
          {t('password.new')}{' '}
          <input
            {...fieldProps('next', fieldErrors.next)}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            onBlur={checkOnBlur('next')}
          />
        </label>{' '}
        {/* The RULE, stated up front and always. It is not an objection, so it
            stays put while the objection comes and goes. */}
        <span className="muted">{t('password.hint', { n: MIN_PASSWORD_LENGTH })}</span>
        <FieldError id="next" message={fieldErrors.next} />
      </p>
      <p>
        <label>
          {t('password.confirm')}{' '}
          <input
            {...fieldProps('confirm', fieldErrors.confirm)}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={checkOnBlur('confirm')}
          />
        </label>
        <FieldError id="confirm" message={fieldErrors.confirm} />
      </p>
      <p>
        {/* D148 — `disabled={!ready}` greyed this out with nothing on screen
            saying which of three boxes it was waiting for. */}
        <button type="button" disabled={busy} aria-busy={busy} onClick={() => void save()}>
          {busy ? t('form.saving') : t('password.save')}
        </button>
      </p>
    </section>
  );
}

/**
 * Everything else on the site, unless the account owes a password change.
 *
 * A hard swap rather than a redirect: a redirect is one `history.back()` away
 * from being undone, and every screen behind it would have to defend itself
 * anyway. The signed-out and still-loading cases pass straight through — this
 * gate must never be what a visitor sees.
 */
export function PasswordGate({ children }: { children: ReactNode }) {
  const t = useT();
  const me = useQuery(meQueryOptions);
  // Owned HERE, not by the page below, and that is the whole point: the
  // refetch that clears `mustChangePassword` unmounts the page in the same
  // tick the change succeeds, so a confirmation held in the page's own state
  // is raised and destroyed together and nobody ever reads it (B-14). This
  // component is the root route's, rendered once for every child route, so it
  // survives both the swap and every client-side navigation after it.
  const [changed, setChanged] = useState(false);
  if (me.data?.mustChangePassword === true) {
    return <ChangePasswordPage forced onChanged={() => setChanged(true)} />;
  }
  return (
    <>
      {changed ? (
        <p role="status">
          {t('password.done')}{' '}
          {/* Dismissible because this component is never remounted: without
              it the line would sit above every screen for the rest of the
              session. */}
          <button type="button" onClick={() => setChanged(false)}>
            {t('password.dismiss')}
          </button>
        </p>
      ) : null}
      {children}
    </>
  );
}

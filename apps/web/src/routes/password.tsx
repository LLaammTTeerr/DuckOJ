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

/** `Password` in `@duckoj/contracts` — restated so the form can refuse early. */
const MIN_PASSWORD_LENGTH = 10;

export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const t = useT();
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // The flag on the account decides, not the prop: a reader who lands on this
  // URL directly while flagged must get the same form the gate would have
  // shown them, and one whose flag was cleared in another tab must not be
  // offered a shortcut that no longer works.
  const mustChange = forced || me.data?.mustChangePassword === true;
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== next;
  const ready =
    next.length >= MIN_PASSWORD_LENGTH && confirm === next && (mustChange || current.length > 0);

  async function save(): Promise<void> {
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
      setCurrent('');
      setNext('');
      setConfirm('');
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
      {done ? <p>{t('password.done')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {mustChange ? null : (
        <p>
          <label>
            {t('password.current')}{' '}
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
        </p>
      )}
      <p>
        <label>
          {t('password.new')}{' '}
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>{' '}
        <span className="muted">{t('password.hint', { n: MIN_PASSWORD_LENGTH })}</span>
      </p>
      <p>
        <label>
          {t('password.confirm')}{' '}
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
      </p>
      {tooShort ? <p className="muted">{t('password.tooShort', { n: MIN_PASSWORD_LENGTH })}</p> : null}
      {mismatch ? <p className="muted">{t('password.mismatch')}</p> : null}
      <p>
        <button type="button" disabled={!ready || busy} onClick={() => void save()}>
          {t('password.save')}
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
  const me = useQuery(meQueryOptions);
  if (me.data?.mustChangePassword === true) return <ChangePasswordPage forced />;
  return <>{children}</>;
}

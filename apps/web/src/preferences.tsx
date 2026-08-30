/**
 * The bridge between the account's stored preferences and the running app.
 *
 * Its own module rather than a component inside `router.tsx`, for exactly the
 * reason `me.ts` is one: a test that wants to prove "the server's locale wins
 * over this browser's" would otherwise have to import the whole route tree —
 * every route file, `createRouter`, and a router mock rich enough to build
 * them — to reach one effect.
 */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { meQueryOptions } from './me.js';
import { useLocale, type Locale } from './i18n/index.js';

/**
 * The server's preferences beat this browser's, once somebody has set one
 * (D57).
 *
 * **Applied when the stored VALUE changes, not on every render and not once
 * per identity.** Both of the simpler rules are wrong, in opposite
 * directions:
 *
 * - *Every render.* The nav's `VI | EN` toggle writes `localStorage` and is
 *   meant to keep working. Re-applying the account's locale on every pass
 *   undoes the reader's click a millisecond after they make it — react-query
 *   hands back a fresh object on every refetch, and the bell already refetches
 *   this entry every minute, so the toggle would appear to work and then snap
 *   back.
 * - *Once per identity.* Saving on `/account/settings` invalidates `['me']`
 *   and brings back a NEW locale for the SAME account, which an identity
 *   guard would swallow — the reader would change their language and watch
 *   nothing happen until the next reload.
 *
 * So the marker is the value itself. A refetch that changes nothing changes
 * nothing here; a sign-in, a sign-out and a save each move it.
 *
 * `null` applies nothing at all, which is what makes "the reader has chosen
 * nothing" behave exactly as it did before this existed: `navigator.language`
 * (D18) and the browser's own zone. Signing out clears only the zone a server
 * value had overridden, rather than forcing a locale onto the visitor left
 * behind — their own choice is still in `localStorage` and still theirs.
 *
 * A well-formed tag this build has no catalogue for (`fr` — the API accepts
 * any BCP-47 tag) is ignored rather than half-applied.
 */
function isKnownLocale(value: string | null | undefined): value is Locale {
  return value === 'vi' || value === 'en';
}

export function PreferenceSync() {
  const me = useQuery(meQueryOptions);
  const { setLocale, setTimeZone } = useLocale();
  const user = me.data ?? null;
  // What was applied last, as a value rather than an object: react-query's
  // reference changes on every refetch and would make a ref of the object
  // itself fire on each one.
  const signature = user === null ? null : `${String(user.id)}|${user.locale ?? ''}|${user.timezone ?? ''}`;
  // `undefined` is "nothing applied yet" — distinct from `null`, which is a
  // signed-out reader and IS a state worth applying once.
  //
  // Belt and braces, deliberately: react-query's structural sharing already
  // hands back the SAME object when a refetch changes nothing, so `user`'s
  // reference is stable and the effect usually does not re-run at all. That
  // is a property of the cache, though, not of this rule — an equivalent
  // mutant (the ref removed) passes today and would stop passing the moment
  // anything about the query's shape defeated the sharing. The ref states
  // the rule where the rule lives.
  const applied = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (applied.current === signature) return;
    applied.current = signature;
    if (!user) {
      setTimeZone(null);
      return;
    }
    if (isKnownLocale(user.locale)) setLocale(user.locale);
    setTimeZone(user.timezone);
    // `user` is in the deps beside `signature` only because the effect reads
    // it; `signature` is what actually decides, and the guard above is what
    // makes a refetch that changed nothing a no-op.
  }, [signature, user, setLocale, setTimeZone]);
  return null;
}

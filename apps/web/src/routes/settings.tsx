/**
 * `/account/settings` — the screen `PATCH /users/me` never had.
 *
 * The endpoint has accepted `displayName`, `timezone` and `locale` since
 * Phase 3, validated them, stored them, and nothing in the product could send
 * any of them: a preference nobody could set, which is why 0023 could treat
 * every stored value as one the default had written (D57).
 *
 * The two preferences are SERVER-side, and that is the whole point of them —
 * a reader who signs in from a school computer, a phone and a competition
 * hall gets their own language and their own clock in all three, which
 * `localStorage` cannot do. Saving therefore applies immediately as well as
 * persisting: the shell adopts the new locale and zone from the refreshed
 * `['me']` (see `router.tsx`'s `PreferenceSync`), so the page the reader is
 * looking at changes under them rather than at the next sign-in.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';
import { useT } from '../i18n/index.js';
import { ThemeToggle } from '../theme.js';

/**
 * `''` is the "no preference" option in both selects, and maps to the `null`
 * the API reads as CLEAR — a distinct instruction from omitting the field,
 * which means keep. A `<select>` cannot hold `null`, so the empty string is
 * the carrier and this is the only place that knows it.
 */
const NO_PREFERENCE = '';

/**
 * A short list, not every IANA zone.
 *
 * The API accepts any zone `Intl` can resolve, so nothing here is a limit on
 * what an account may hold — a value set through the API that is not on this
 * list is still shown (see `zoneChoices`). A picker of six hundred zones to
 * choose between Hanoi and one other place is a worse control than a short
 * list plus an honest "leave it to my browser".
 */
const COMMON_ZONES = [
  'Asia/Ho_Chi_Minh',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

function zoneChoices(current: string | null): string[] {
  if (current === null || COMMON_ZONES.includes(current)) return COMMON_ZONES;
  return [current, ...COMMON_ZONES];
}

export function SettingsPage() {
  const t = useT();
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);

  const [displayName, setDisplayName] = useState('');
  const [locale, setLocaleChoice] = useState<string>(NO_PREFERENCE);
  const [timezone, setTimezone] = useState<string>(NO_PREFERENCE);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // Which account the form was seeded FROM — the same discipline
  // `contest-edit.tsx` documents, and it matters here for the same reason:
  // signing out and back in as somebody else must not leave the previous
  // reader's display name sitting in a box that then saves it.
  const [seededFrom, setSeededFrom] = useState<number | null>(null);
  useEffect(() => {
    const user = me.data;
    if (!user || seededFrom === user.id) return;
    setDisplayName(user.displayName);
    setLocaleChoice(user.locale ?? NO_PREFERENCE);
    setTimezone(user.timezone ?? NO_PREFERENCE);
    setSeededFrom(user.id);
  }, [seededFrom, me.data]);

  async function save(): Promise<void> {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const { error: err } = await api.PATCH('/users/me', {
        body: {
          displayName,
          // `null`, never omitted: the form SHOWS both preferences, so it has
          // to be able to save "none" as well as a value.
          locale: locale === NO_PREFERENCE ? null : locale,
          timezone: timezone === NO_PREFERENCE ? null : timezone,
        },
      });
      if (err) {
        setError(err.detail ?? t('settings.saveError'));
        return;
      }
      setSaved(true);
      // The shell reads the locale and the zone off this entry, so the page
      // switches language the moment the save lands.
      await client.invalidateQueries({ queryKey: ['me'] });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  if (me.isLoading) return <p className="muted">{t('common.loading')}</p>;
  if (!me.data) return <p role="alert">{t('settings.signedOut')}</p>;

  return (
    <section className="panel">
      <h1>{t('settings.title')}</h1>
      <p>
        <label>
          {t('settings.displayName')}{' '}
          <input
            aria-label={t('settings.displayName')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
      </p>
      <p>
        <label>
          {t('settings.locale')}{' '}
          <select
            aria-label={t('settings.locale')}
            value={locale}
            onChange={(e) => setLocaleChoice(e.target.value)}
          >
            {/* The VALUES are BCP-47 tags going on the wire; only the labels
                are prose. `''` is "no preference" — see NO_PREFERENCE. */}
            <option value={NO_PREFERENCE}>{t('settings.localeAuto')}</option>
            <option value="vi">{t('nav.languageVi')}</option>
            <option value="en">{t('nav.languageEn')}</option>
          </select>
        </label>
      </p>
      <p className="muted">{t('settings.localeHint')}</p>
      <p>
        <label>
          {t('settings.timezone')}{' '}
          <select
            aria-label={t('settings.timezone')}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            <option value={NO_PREFERENCE}>{t('settings.timezoneAuto')}</option>
            {/* Zone NAMES are IANA identifiers, not words to translate. */}
            {zoneChoices(me.data.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p className="muted">{t('settings.timezoneHint')}</p>

      {/* Per-device, so it applies the instant it is clicked and has no part
          in the Save below (which writes the account-side preferences). D116. */}
      <p>
        {t('settings.theme')} <ThemeToggle />
      </p>
      <p className="muted">{t('settings.themeHint')}</p>

      {error ? <p role="alert">{error}</p> : null}
      {saved ? <p role="status">{t('settings.saved')}</p> : null}
      <p>
        <button type="button" disabled={busy || displayName.trim() === ''} onClick={() => void save()}>
          {t('settings.save')}
        </button>
      </p>
    </section>
  );
}

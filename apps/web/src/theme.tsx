/**
 * The manual light / dark / system theme control (D116).
 *
 * Until this existed the interface followed the OS alone (`tokens.css`'s
 * `@media (prefers-color-scheme: dark)`). This adds a reader-chosen override:
 * `data-theme="light"|"dark"` on `<html>` forces a scheme, and `"system"`
 * removes the attribute so `prefers-color-scheme` decides again.
 *
 * DELIBERATELY PER-DEVICE, and that is the whole difference from the locale
 * and zone on `/account/settings` (D57), which are per-ACCOUNT. A display
 * choice follows the SCREEN, not the person: the phone a pupil reads in bed
 * wants dark, the projector in the classroom wants light, and the same
 * account is behind both. So this lives in `localStorage`, never on the
 * server — the exact opposite of the reasoning D57 records for language.
 *
 * The choice is applied a SECOND time, before this module ever loads, by a
 * tiny inline script in `index.html`: the `--bg` wash paints when the
 * stylesheet loads, before the deferred bundle runs, so the pre-paint script
 * is what prevents a light-then-dark flash. This module owns the WRITE side
 * (a control changed the choice) and keeps the DOM in step from then on.
 *
 * A module-level store read through `useSyncExternalStore`, not a context:
 * two controls (the nav and `/account/settings`) are mounted at once and must
 * agree instantly, and — like `useLocale`'s bare fallback — a component that
 * renders the toggle must not need a provider above it to do so. The snapshot
 * is `localStorage` itself, so nothing to reset between renders; the DOM and
 * the one key are the only state, and both are per-test cleared in
 * `test/setup.ts`.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import { useT, type MsgKey } from './i18n/index.js';

export type Theme = 'light' | 'dark' | 'system';

/** Where this browser's own choice is remembered. Per-device, never synced. */
export const THEME_STORAGE_KEY = 'duckoj.theme';

/** The theme when the reader has chosen nothing: follow the OS. */
export const DEFAULT_THEME: Theme = 'system';

const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * The stored choice, or `"system"`.
 *
 * Every access is guarded: `localStorage` THROWS (rather than answering null)
 * in a browser set to block site data and inside some embedded webviews, and
 * a theme toggle is not worth taking the app down for — exactly the rule
 * `resolveInitialLocale` follows.
 */
export function readStoredTheme(): Theme {
  try {
    const stored = globalThis.localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // no storage: the OS scheme is the honest fallback
  }
  return DEFAULT_THEME;
}

/**
 * Put the choice on `<html>`. `"system"` REMOVES the attribute — the absence
 * is what hands the decision back to `prefers-color-scheme`; an empty or
 * `"system"` attribute value would instead match neither CSS trigger and
 * strand the reader on the light default even on a dark OS.
 */
export function applyTheme(theme: Theme): void {
  const el = globalThis.document?.documentElement;
  if (!el) return;
  if (theme === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', theme);
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Change the theme: persist it (guarded — a locked-down browser still gets
 * the switch for this page view, it just does not survive a reload), apply it
 * to the DOM, and wake every mounted control so the nav and the settings page
 * agree at once.
 */
export function setTheme(next: Theme): void {
  try {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // storage blocked — degrade to a choice that lasts this page view only
  }
  applyTheme(next);
  for (const onChange of listeners) onChange();
}

/** The active choice plus the setter. Usable with no provider above it. */
export function useTheme(): readonly [Theme, (next: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, readStoredTheme, readStoredTheme);
  return [theme, setTheme] as const;
}

/**
 * The three-way switch. Radio-group semantics: `role="group"` with a name,
 * three buttons each carrying `aria-pressed` (rather than colour) for the
 * active one — the same shape as the `VI | EN` `LocaleToggle`. Every button
 * is a 44px target and reachable by keyboard.
 */
export function ThemeToggle(): ReactNode {
  const t = useT();
  const [theme, choose] = useTheme();
  return (
    <span className="theme-toggle" role="group" aria-label={t('theme.label')}>
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={theme === option}
          onClick={() => {
            choose(option);
          }}
        >
          {t(`theme.${option}` as MsgKey)}
        </button>
      ))}
    </span>
  );
}

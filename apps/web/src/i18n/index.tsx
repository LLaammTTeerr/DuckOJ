/**
 * The whole i18n mechanism: two flat catalogues, a `t()`, a React context,
 * and the `Intl` wrappers that make dates and relative times follow the same
 * locale as the words around them.
 *
 * No i18n library (D18). The app has exactly two locales and a few hundred
 * strings; `react-i18next` and friends bring a plugin system, a backend
 * loader, a suspense integration and an ICU parser, none of which this app
 * would use, in exchange for the one thing this file gives up: plural
 * categories. Vietnamese has no plural inflection at all, and the single
 * English message that needed one (`admin.replayed*`) is expressed as two
 * keys rather than a rule engine.
 *
 * Key parity is a TYPE relationship, not a convention: `en.ts` is the
 * authority (`MsgKey = keyof typeof en`) and `vi.ts` is
 * `satisfies Record<MsgKey, string>`, so `tsc` catches a forgotten
 * translation. `test/i18n.spec.ts` asserts it again at runtime, in both
 * directions, because `satisfies` alone would not catch an EXTRA key in
 * `vi.ts` that no longer exists in `en.ts`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en, type MsgKey } from './en.js';
import { vi } from './vi.js';

export type { MsgKey } from './en.js';
export { en } from './en.js';
export { vi } from './vi.js';

export type Locale = 'vi' | 'en';

/** Both catalogues, keyed by the tag that goes in `<html lang>`. */
const CATALOGUES: Record<Locale, Record<MsgKey, string>> = { vi, en };

/**
 * The BCP-47 tag handed to `Intl`. Deliberately region-qualified: bare `vi`
 * and `en` leave the date order and the decimal separator up to the
 * runtime's default region, which on a server-rendered or containerised
 * runtime is whatever the image happened to be built with.
 */
const INTL_LOCALES: Record<Locale, string> = { vi: 'vi-VN', en: 'en-US' };

/** Where the viewer's own choice is remembered, per the brief. */
export const LOCALE_STORAGE_KEY = 'duckoj.locale';

/** Vietnamese is the default — this is a Vietnamese olympiad judge (D18). */
export const DEFAULT_LOCALE: Locale = 'vi';

function isLocale(value: unknown): value is Locale {
  return value === 'vi' || value === 'en';
}

/**
 * The locale to start in: an explicit stored choice wins; otherwise a
 * browser whose language is English gets English; everyone else gets
 * Vietnamese.
 *
 * Every access is guarded. `localStorage` THROWS (rather than returning
 * null) in a browser configured to block site data and inside some embedded
 * webviews, and a language toggle is not worth taking the whole app down
 * for.
 */
export function resolveInitialLocale(): Locale {
  try {
    const stored = globalThis.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // no storage: fall through to the navigator sniff
  }
  try {
    if (globalThis.navigator.language.toLowerCase().startsWith('en')) return 'en';
  } catch {
    // no navigator: fall through to the default
  }
  return DEFAULT_LOCALE;
}

function storeLocale(locale: Locale): void {
  try {
    globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage blocked — the choice still applies to this page view, it just
    // does not survive a reload. Silently degrading beats refusing to switch.
  }
}

export type Vars = Record<string, string | number>;

/**
 * One message, with `{name}` placeholders filled in.
 *
 * A placeholder with no matching var is left as-is rather than blanked: a
 * visible `{code}` on screen is a bug report, an empty gap is a mystery.
 */
export function translate(locale: Locale, key: MsgKey, vars?: Vars): string {
  // The key itself when nothing is behind it. `MsgKey` makes a literal key
  // safe, but three call sites build theirs from a value the SERVER chose —
  // `revState.${r.state}` (problem-revisions.tsx), `visibility.${v}` and
  // `sourceAccess.${s}` (problem-edit.tsx) — so an enum value this build has
  // never heard of arrives here as a miss. Without the fallback that miss
  // rendered BLANK (React draws nothing for `undefined`), and with `vars` it
  // threw `Cannot read properties of undefined (reading 'replace')` mid-render
  // and took the page down. A visible `revState.frozen` on screen is a bug
  // report; an empty badge is a mystery. (final-review m18)
  const template = CATALOGUES[locale][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export type TFunction = (key: MsgKey, vars?: Vars) => string;

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * The locale used by a component rendered with no `LocaleProvider` above it.
 *
 * Resolved LAZILY, on first use, never at module load: `test/setup.ts` seeds
 * `localStorage` so the whole unit suite renders in the app's real default
 * (Vietnamese) rather than in whatever `navigator.language` jsdom reports
 * (`en-US`), and a module-load-time constant would be computed before some
 * of that setup had a chance to run.
 */
let fallbackLocale: Locale | null = null;
function defaultLocale(): Locale {
  fallbackLocale ??= resolveInitialLocale();
  return fallbackLocale;
}

/** Test-only escape hatch: forget the memoized bare-render fallback. */
export function resetFallbackLocale(): void {
  fallbackLocale = null;
}

export function LocaleProvider(props: { children: ReactNode; initialLocale?: Locale }) {
  const { initialLocale } = props;
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? resolveInitialLocale());

  // `<html lang>` follows the active locale. It is what a screen reader picks
  // its voice from and what a browser offers to translate against, so leaving
  // it at the static `vi` in index.html would mislabel every English page.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    storeLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<LocaleContextValue>(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{props.children}</LocaleContext.Provider>;
}

/** The active locale, plus the setter the nav toggle calls. */
export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  // A component rendered bare (every unit test that does not need the toggle)
  // still translates — it simply cannot switch.
  return ctx ?? { locale: defaultLocale(), setLocale: () => undefined };
}

/** `t` for the active locale. Stable across renders while the locale is. */
export function useT(): TFunction {
  const { locale } = useLocale();
  return useMemo<TFunction>(() => (key, vars) => translate(locale, key, vars), [locale]);
}

/** The long name behind a verdict code, for tooltips and legends. */
export function verdictName(t: TFunction, code: string): string {
  const key = `verdict.${code}` as MsgKey;
  return key in en ? t(key) : code;
}

/**
 * A tag's name in the active locale.
 *
 * Takes the locale rather than `t`, because unlike every other label in this
 * app a tag's words are DATA, not catalogue entries: they live in the `tags`
 * table (both spellings on one row, D18 — two locales, no translation
 * table), and every response that carries a tag carries both. So the switch
 * is a field pick here, not a lookup, and changing locale re-renders from
 * data already in hand rather than refetching every problem on screen.
 */
export function tagName(locale: Locale, tag: { nameVi: string; nameEn: string }): string {
  return locale === 'vi' ? tag.nameVi : tag.nameEn;
}

/**
 * A rank band's title in the active locale.
 *
 * Takes the locale rather than `t`, for the same reason `tagName` above
 * does: a band's words are DATA, not catalogue entries. They live on one row
 * of `packages/glicko2`'s `RANK_BANDS` table (D46), both spellings together,
 * so switching locale re-renders from a value already in hand and renaming a
 * rank is an edit to that table alone — not an edit there plus two catalogue
 * edits that can drift apart.
 */
export function rankTitle(locale: Locale, band: { nameVi: string; nameEn: string }): string {
  return locale === 'vi' ? band.nameVi : band.nameEn;
}

/**
 * A global role (`user`/`setter`/`admin`) as a word.
 *
 * Takes a bare `string`, not the union: it is called with values that arrive
 * from the server inside a notification payload, where the type is only
 * `unknown` narrowed to `string`. An unrecognised role falls back to itself
 * rather than to a wrong word — a role this build has never heard of should
 * read as its raw name, not as "user".
 */
export function globalRoleLabel(t: TFunction, role: string): string {
  const key = `globalRole.${role}` as MsgKey;
  return key in en ? t(key) : role;
}

// ── dates and numbers ──────────────────────────────────────────────────────
//
// Every `toLocaleString()`/`toLocaleDateString()` in this app used to run
// with NO locale argument, which means "whatever the browser is set to" —
// so a Vietnamese page rendered American dates on an American laptop. These
// take the ACTIVE locale instead, so the words and the dates agree.
//
// Note what is deliberately NOT here: score formatting. `formatPoints`
// (`src/format.ts`) prints a bare machine-readable number into a monospace
// column on purpose, and adding a locale's thousands separator to it would
// be a regression, not a localization — see that file's doc comment.

/** `2026-03-01T09:00:00Z` → `01/03/2026 16:00` (vi) / `3/1/2026 04:00` (en). */
export function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString(INTL_LOCALES[locale]);
  const time = date.toLocaleTimeString(INTL_LOCALES[locale], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${day} ${time}`;
}

/**
 * Time only, `HH:MM`, in the active locale's own clock. The scoreboard's
 * freeze banner names an instant inside a contest that is running right now,
 * so the date is noise — the reader knows what day it is.
 */
export function formatTime(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleTimeString(INTL_LOCALES[locale], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Date only, in the active locale's own order. */
export function formatDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleDateString(INTL_LOCALES[locale]);
}

/** Date and time, in the active locale's own order. */
export function formatTimestamp(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleString(INTL_LOCALES[locale]);
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * "3 ngày trước" / "3 days ago", via `Intl.RelativeTimeFormat` — the grammar
 * (including Vietnamese's postposed "trước") comes from the runtime, never
 * from a hand-written table here.
 *
 * Used by the notification feed, where "when did this happen" is the whole
 * question and an absolute timestamp makes the reader do the subtraction.
 * The absolute value is still available: the caller puts it in `title`.
 */
export function formatRelative(iso: string, locale: Locale, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 60) return translate(locale, 'time.justNow');
  const formatter = new Intl.RelativeTimeFormat(INTL_LOCALES[locale], { numeric: 'auto' });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (magnitude >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return translate(locale, 'time.justNow');
}

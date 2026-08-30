import { describe, expect, it, vi as vitestMock, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
// `vi` is vitest's own name in every other spec file, so the Vietnamese
// catalogue is aliased on import here rather than shadowing it.
import { en, type MsgKey } from '../src/i18n/en.js';
import { ShellNav } from '../src/router.js';
import { vi as viMessages } from '../src/i18n/vi.js';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  LocaleProvider,
  formatRelative,
  resetFallbackLocale,
  resolveInitialLocale,
  translate,
  useLocale,
  useT,
} from '../src/i18n/index.js';

describe('the catalogues', () => {
  it('cover exactly the same keys, in both directions', () => {
    const enKeys = Object.keys(en).sort();
    const viKeys = Object.keys(viMessages).sort();
    // Both directions on purpose: `satisfies Record<MsgKey, string>` in vi.ts
    // already makes a MISSING key a typecheck failure, but an EXTRA key left
    // behind after a message is deleted from en.ts is invisible to it.
    expect(viKeys).toEqual(enKeys);
  });

  it('carries Vietnamese diacritics in NFC', () => {
    // A decomposed "ế" (e + U+0302 + U+0301) renders identically and breaks
    // every string comparison, every `getByText`, and the browser's own
    // find-in-page. Normalizing must be a no-op.
    for (const [key, value] of Object.entries(viMessages)) {
      expect(value.normalize('NFC'), `${key} is not NFC`).toBe(value);
    }
  });

  // Three lookups in this app build their key from a value the SERVER chose
  // — `revState.${r.state}` (problem-revisions.tsx), `visibility.${v}` and
  // `sourceAccess.${s}` (problem-edit.tsx). `verdictName` and
  // `globalRoleLabel` guard theirs with `key in en`; these do not. An enum
  // value this build has never heard of therefore reached `translate` with
  // no entry behind it, and a catalogue miss is not a typecheck failure at
  // a template literal. (final-review m18)
  it('falls back to the key itself rather than rendering blank', () => {
    // `undefined` here reaches React as a child, which renders NOTHING: the
    // badge on the revisions table would be an empty box with no clue in it.
    expect(translate('vi', 'revState.a-state-this-build-never-heard-of' as MsgKey)).toBe(
      'revState.a-state-this-build-never-heard-of',
    );
    expect(translate('en', 'nope.nope' as MsgKey)).toBe('nope.nope');
  });

  it('does not throw when a missing key is asked for with variables', () => {
    // The worse half of the same hole: `template.replace` on `undefined` is a
    // TypeError thrown during render, which takes the whole page down rather
    // than one label.
    expect(() => translate('vi', 'nope.nope' as MsgKey, { n: 1 })).not.toThrow();
    expect(translate('vi', 'nope.nope' as MsgKey, { n: 1 })).toBe('nope.nope');
  });

  it('translates nothing to the empty string', () => {
    for (const [key, value] of Object.entries(viMessages)) {
      expect(value.trim(), `${key} is blank`).not.toBe('');
    }
  });

  it('keeps a Vietnamese message for every English one that takes a variable', () => {
    // A `{name}` dropped in translation is a silently missing fact on screen,
    // not a visible bug — so the placeholder sets must match per key.
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(viMessages[key]), `${key} placeholders`).toEqual(
        placeholders(en[key]),
      );
    }
  });
});

describe('translate', () => {
  it('interpolates {name} placeholders', () => {
    expect(translate('en', 'nav.notifications', { count: 3 })).toBe('Notifications, 3 unread');
    expect(translate('vi', 'nav.notifications', { count: 3 })).toBe('Thông báo, 3 chưa đọc');
  });

  it('leaves an unsupplied placeholder visible rather than blanking it', () => {
    expect(translate('en', 'nav.notifications')).toContain('{count}');
  });
});

describe('resolveInitialLocale', () => {
  afterEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'vi');
    resetFallbackLocale();
  });

  it('prefers a stored choice', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    expect(resolveInitialLocale()).toBe('en');
  });

  it('falls back to English for an English browser with no stored choice', () => {
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    // jsdom reports en-US, which is exactly the fallback case.
    expect(resolveInitialLocale()).toBe('en');
  });

  it('falls back to Vietnamese for any other browser language', () => {
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    const spy = vitestMock.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR');
    try {
      expect(resolveInitialLocale()).toBe(DEFAULT_LOCALE);
      expect(DEFAULT_LOCALE).toBe('vi');
    } finally {
      spy.mockRestore();
    }
  });

  it('ignores a junk stored value', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'klingon');
    const spy = vitestMock.spyOn(navigator, 'language', 'get').mockReturnValue('vi-VN');
    try {
      expect(resolveInitialLocale()).toBe('vi');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-08-29T12:00:00Z');

  it('reads as Vietnamese, with the runtime supplying the grammar', () => {
    expect(formatRelative('2026-08-26T12:00:00Z', 'vi', now)).toBe('3 ngày trước');
  });

  it('reads as English in English', () => {
    expect(formatRelative('2026-08-26T12:00:00Z', 'en', now)).toBe('3 days ago');
  });

  it('says "just now" under a minute rather than "0 seconds ago"', () => {
    expect(formatRelative('2026-08-29T11:59:40Z', 'vi', now)).toBe('vừa xong');
  });
});

/**
 * The real shell nav, under a router context built the same way every other
 * spec in this suite builds one (`RouterContextProvider`, an in-memory
 * history, no relation to the app's own route tree) — `<Link>` throws
 * without one.
 */
function renderShell(initialLocale: 'vi' | 'en') {
  const testRootRoute = createRootRoute();
  const testRouter = createRouter({
    routeTree: testRootRoute.addChildren([
      createRoute({ getParentRoute: () => testRootRoute, path: '/' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterContextProvider router={testRouter}>
        <LocaleProvider initialLocale={initialLocale}>
          <ShellNav />
        </LocaleProvider>
      </RouterContextProvider>
    </QueryClientProvider>,
  );
}

describe('the language toggle, to a screen reader', () => {
  // `aria-label` on a bare <span> labels nothing: the implicit role is
  // `generic`, which is not in the set ARIA lets you name, so the group's
  // own label was dropped and the two buttons were announced as unlabelled
  // "VI" and "EN" — two letters that mean nothing in the language the reader
  // cannot read. The two catalogue keys written for exactly this
  // (`nav.languageVi`/`nav.languageEn`) were defined and used nowhere.
  // (final-review m19)
  it('is a named group', () => {
    renderShell('vi');
    expect(screen.getByRole('group', { name: viMessages['nav.language'] })).toBeInTheDocument();
  });

  it('names each button in words, not just the two letters on it', () => {
    renderShell('vi');
    expect(
      screen.getByRole('button', { name: viMessages['nav.languageVi'] }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: viMessages['nav.languageEn'] }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('names them in English once the reader has switched', () => {
    renderShell('en');
    expect(screen.getByRole('button', { name: en['nav.languageEn'] })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

/** A miniature of the shell's nav: the toggle plus one translated link. */
function NavProbe() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <nav>
      <span>{t('nav.problems')}</span>
      <span data-testid="lang">{locale}</span>
      <button type="button" aria-pressed={locale === 'vi'} onClick={() => setLocale('vi')}>
        VI
      </button>
      <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
        EN
      </button>
    </nav>
  );
}

describe('LocaleProvider', () => {
  afterEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'vi');
    resetFallbackLocale();
  });

  it('renders Vietnamese by default and English after the toggle', async () => {
    render(
      <LocaleProvider initialLocale="vi">
        <NavProbe />
      </LocaleProvider>,
    );
    expect(screen.getByText('Bài tập')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'EN' }));

    expect(screen.getByText('Problems')).toBeInTheDocument();
    expect(screen.queryByText('Bài tập')).not.toBeInTheDocument();
  });

  it('persists the choice, so the next visit starts there', async () => {
    render(
      <LocaleProvider initialLocale="vi">
        <NavProbe />
      </LocaleProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('follows the active locale with <html lang>', async () => {
    render(
      <LocaleProvider initialLocale="vi">
        <NavProbe />
      </LocaleProvider>,
    );
    expect(document.documentElement.lang).toBe('vi');
    await userEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(document.documentElement.lang).toBe('en');
  });

  it('still translates a component rendered with no provider above it', () => {
    // Every route spec in this suite renders its component bare. They must
    // get the app's real default rather than a crash or a raw key.
    render(<NavProbe />);
    expect(screen.getByTestId('lang')).toHaveTextContent('vi');
    expect(screen.getByText('Bài tập')).toBeInTheDocument();
  });
});

describe('the real shell nav', () => {
  it('renders every link in Vietnamese by default', () => {
    renderShell('vi');
    expect(screen.getByRole('link', { name: 'Bài tập' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kỳ thi' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tổ chức' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bài nộp' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Đăng nhập' })).toBeInTheDocument();
    // The product name is not a translatable string.
    expect(screen.getByText('DuckOJ')).toBeInTheDocument();
  });

  it('renders them in English after the toggle, and marks the active language', async () => {
    // Queried by the buttons' ACCESSIBLE names, which are the language names
    // now that each button carries one — the visible glyphs are still "VI"
    // and "EN", asserted separately below.
    renderShell('vi');
    expect(
      screen.getByRole('button', { name: viMessages['nav.languageVi'] }),
    ).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: viMessages['nav.languageEn'] }));

    expect(screen.getByRole('link', { name: 'Problems' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contests' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Bài tập' })).not.toBeInTheDocument();
    const enButton = screen.getByRole('button', { name: en['nav.languageEn'] });
    const viButton = screen.getByRole('button', { name: en['nav.languageVi'] });
    expect(enButton).toHaveAttribute('aria-pressed', 'true');
    expect(viButton).toHaveAttribute('aria-pressed', 'false');
    // The two letters a sighted reader picks the toggle out by are unchanged.
    expect(enButton).toHaveTextContent('EN');
    expect(viButton).toHaveTextContent('VI');
  });
});

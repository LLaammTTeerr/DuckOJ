/**
 * The shell's navigation — D76.
 *
 * Split out of `router.tsx` (which re-exports `ShellNav`, so
 * `test/i18n.spec.tsx` and `test/logout.spec.tsx` keep importing it from
 * there) because the nav is no longer one flat row of links: it is two
 * information architectures that share one component, and it now owns real
 * behaviour — an overflow sheet with a focus trap — that has no business
 * living beside the route tree.
 *
 * THE PROBLEM. The signed-in bar carried twelve items in a single flat row.
 * On a desktop that is a wall of equal-weight links with no answer to "which
 * of these is the app and which is my account"; at 390px it was a sideways
 * scroller, which the Liquid Glass review (D67, concern 1) flagged: a real
 * bottom tab bar is at most five items, and anything that has to be swiped
 * into view is, for most readers, not there at all.
 *
 * THE SHAPE.
 *   - Desktop (>700px): ONE glass bar, three named clusters —
 *     `Bài tập · Kỳ thi · Bài nộp · Tổ chức` (where the work is), then
 *     resources (`Trợ giúp`, `API`, and `Quản trị` for an admin), then the
 *     account cluster pushed to the right rail (bell, display name,
 *     settings, security, tokens, password, language, sign out).
 *   - Phone (≤700px): five bottom tabs — problems, contests, submissions,
 *     the bell (or `Đăng nhập` for a visitor), and `Thêm`, which opens a
 *     glass sheet holding everything else. Every route the old bar reached
 *     is still one tap away, or two through the sheet.
 *
 * WHY THE ACCOUNT CLUSTER IS NOT A DROPDOWN. It groups, it does not collapse.
 * Two reasons, and the second is the real one. The e2e journeys assert the
 * sign-out button and the display name are VISIBLE with no interaction
 * (`e2e/journey.spec.ts`, `e2e/smoke.spec.ts`) — but they assert it because
 * of what this app is: shared school machines, where "the previous pupil is
 * still signed in" is the default state, and a way out that costs a
 * discovery click is a way out nobody takes. On a phone, where there is
 * genuinely no room, sign-out moves into the sheet and is two taps; on a
 * desktop, where there is room, it stays on screen.
 *
 * WHICH TREE RENDERS is a JS media query, not CSS: the sheet cannot exist as
 * a CSS state, and rendering BOTH trees would put every link in the document
 * twice, which breaks every `getByRole('link', …)` in the suite. jsdom has no
 * `window.matchMedia`, so `usePhoneLayout` answers false there and the whole
 * existing unit suite goes on exercising the desktop bar unchanged.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from './api.js';
import { dropDepartingViewerCache, meQueryOptions } from './me.js';
import { notificationsQueryOptions } from './routes/notifications.js';
import { useLocale, useT } from './i18n/index.js';
import { ThemeToggle } from './theme.js';
import { Avatar } from './avatar.js';

/** The one breakpoint. Kept in step with `app.css`'s `@media (max-width: 700px)`. */
export const PHONE_QUERY = '(max-width: 700px)';

function matchesPhone(): boolean {
  // `typeof window.matchMedia === 'function'` rather than a truthiness check:
  // jsdom does not implement it at all, and a test that stubs it wants the
  // stub, not a guess.
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE_QUERY).matches
    : false;
}

/**
 * Which shell to render. Subscribes to the query so a rotated phone or a
 * dragged desktop window swaps architectures without a reload.
 */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(matchesPhone);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(PHONE_QUERY);
    const onChange = (): void => {
      setPhone(mql.matches);
    };
    // Read once here too: the first paint used the value from `useState`'s
    // initializer, and a stub installed between render and effect (or a
    // resize during hydration) would otherwise be missed.
    onChange();
    if (typeof mql.addEventListener !== 'function') return undefined;
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, []);
  return phone;
}

/* --- icons ---------------------------------------------------------------
 * Inline stroke SVGs, `currentColor`, `aria-hidden` — never emoji, which
 * render as somebody else's artwork at somebody else's size and are read
 * aloud as their CLDR name. A tab is an icon ABOVE a word, never an icon
 * alone: a glyph with no caption is a guess, and this app's readers are
 * pupils meeting it for the first time.
 */
const ICON_PATHS: Record<string, string[]> = {
  problems: ['M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  contests: ['M8 4h8v5a4 4 0 0 1-8 0V4Z', 'M8 5H5v1.5A3.5 3.5 0 0 0 8.5 10', 'M16 5h3v1.5A3.5 3.5 0 0 1 15.5 10', 'M12 13v4', 'M8.5 20h7'],
  submissions: ['M12 3v9', 'm8.5 6.5 3.5-3.5 3.5 3.5', 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'],
  bell: ['M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6', 'M13.7 19a2 2 0 0 1-3.4 0'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  signIn: ['M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4', 'M10 16l4-4-4-4', 'M14 12H4'],
};

function NavIcon({ name }: { name: keyof typeof ICON_PATHS | string }): ReactNode {
  const paths = ICON_PATHS[name] ?? [];
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 2.6 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * The VI | EN switch. Two buttons rather than one that toggles: "the other
 * language" is a riddle in a language you cannot read, while both names
 * present at once is legible to either reader. The active one carries
 * `aria-pressed`, and `setLocale` persists the choice (see i18n/index.tsx).
 */
function LocaleToggle(): ReactNode {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    // `role="group"` is load-bearing, not decoration: a bare <span>'s
    // implicit role is `generic`, which ARIA does not allow a name on, so
    // the `aria-label` here was simply dropped. And "VI"/"EN" as the whole
    // of a button's accessible name is two letters in a language the reader
    // may not have — so each button carries the language's own name, which
    // is what `nav.languageVi`/`nav.languageEn` were written for.
    <span className="nav-locale" role="group" aria-label={t('nav.language')}>
      <button
        type="button"
        aria-label={t('nav.languageVi')}
        aria-pressed={locale === 'vi'}
        onClick={() => {
          setLocale('vi');
        }}
      >
        VI
      </button>
      <button
        type="button"
        aria-label={t('nav.languageEn')}
        aria-pressed={locale === 'en'}
        onClick={() => {
          setLocale('en');
        }}
      >
        EN
      </button>
    </span>
  );
}

/**
 * The way out. `POST /auth/logout` has existed since Phase 1 with no control
 * anywhere in the app — the only way to end a session was to clear the
 * cookie by hand, which on a shared school machine means the previous pupil
 * stays signed in. Found by Task P5.
 *
 * The cache is RESET rather than merely invalidated: `['me']` is not the
 * only entry holding the departing viewer's data (the notification feed, a
 * private problem list, a contest participation), and leaving those to
 * refetch would paint one person's data under the next person's session.
 * A failed call still signs out locally — a cookie the server has already
 * forgotten must not trap the browser in a session it cannot leave.
 */
function SignOutButton(): ReactNode {
  const t = useT();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function signOut(): Promise<void> {
    setBusy(true);
    try {
      await api.POST('/auth/logout');
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
    } finally {
      setBusy(false);
      // `['me']` first, and to exactly what a signed-out `fetchMe` returns:
      // every `enabled` flag in the app keys off it (the bell polls only
      // while signed in), so flipping it before touching anything else is
      // what stops the shell from firing one more authenticated request that
      // can only 401. `resetQueries()` — the first attempt — did fire one,
      // because it refetches active queries before any of them has
      // re-rendered as signed out.
      client.setQueryData(meQueryOptions.queryKey, null);
      // Everything else is REMOVED rather than invalidated or reset: those
      // answers belong to the person leaving, and re-asking for them as a
      // visitor is both pointless and, on a shared machine, the wrong
      // instinct. `clear()` cannot do this job — it drops `['me']` too, and
      // a mounted observer whose query vanished keeps rendering the data it
      // last saw, so the nav went on showing the departed viewer's name.
      //
      // Shared with the sign-IN path (B-34): the hazard is the swap, not the
      // direction, and this half having the rule while the other half did not
      // is how the other half stayed wrong.
      dropDepartingViewerCache(client);
    }
  }
  return (
    <button
      type="button"
      className="nav-signout"
      disabled={busy}
      onClick={() => void signOut()}
    >
      {t('nav.signOut')}
    </button>
  );
}

/** What the shell knows about the viewer, resolved once and handed to both trees. */
interface Viewer {
  username: string;
  displayName: string;
  isAdmin: boolean;
}

function useViewer(): { viewer: Viewer | null; unread: number } {
  const me = useQuery(meQueryOptions);
  // The bell. Polled once a minute while signed in; `enabled` keeps a
  // signed-out shell from asking at all.
  const feed = useQuery({
    ...notificationsQueryOptions,
    enabled: me.data != null,
    refetchInterval: 60_000,
  });
  const viewer = me.data
    ? {
        username: me.data.username,
        displayName: me.data.displayName,
        isAdmin: me.data.globalRole === 'admin',
      }
    : null;
  return { viewer, unread: feed.data?.unreadCount ?? 0 };
}

/**
 * The bell, in both trees. The unread count is rendered twice on purpose:
 * once as a badge a sighted reader sees at a glance, and once inside the
 * `aria-label` sentence (`nav.notifications`, "Thông báo, 3 chưa đọc") that a
 * screen reader speaks. The badge itself is `aria-hidden` so the count is not
 * read out twice in a row with no grammar around it.
 */
function BellBadge({ unread }: { unread: number }): ReactNode {
  if (unread <= 0) return null;
  return (
    <span className="nav-badge" aria-hidden="true">
      {unread > 99 ? '99+' : unread}
    </span>
  );
}

/**
 * The account overflow (D139).
 *
 * THE PROBLEM D76 did not foresee. The bar is capped at 960px, so a signed-in
 * viewer had 928px of room for twelve account-cluster items plus seven on the
 * left — 1376px of pills, measured. It wrapped to THREE rows at 1280px, a
 * 142px band of chrome above every screen with `Dang xuat` alone on the last
 * line: the nav had quietly become the largest object on the page.
 *
 * WHAT MOVES AND WHAT DOES NOT. D76's rule is not "nothing collapses" — it is
 * that the way OUT must not cost a discovery click, because these are shared
 * school machines and the previous pupil is still signed in. So the bell, the
 * viewer's name, the language switch and sign-out stay on the bar, exactly as
 * the e2e journeys assert them. What moves behind this button is the five
 * ACCOUNT PAGES (progress, settings, security, tokens, password) and the
 * theme choice — six things a reader goes looking for deliberately, none of
 * which anyone needs to see to know where they are. It reuses the phone
 * sheet's own word for overflow, so the two architectures name the same idea
 * identically.
 *
 * A DISCLOSURE, NOT A MENU. No `role="menu"`: that role brings arrow-key
 * roving focus with it, and a list of ordinary links owes the reader plain
 * Tab. `aria-expanded` + `aria-controls` on the button is the whole contract.
 * Escape closes it, a pointer press anywhere outside closes it, following a
 * link closes it, and closing returns focus to the button — the same rules as
 * the phone sheet, minus the modal trap, because this panel does not cover
 * the page.
 */
function AccountMenu({ children }: { children: ReactNode }): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  function close(): void {
    setOpen(false);
    buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    // `pointerdown`, not `click`: a click on a link inside the panel would
    // otherwise race the link's own navigation, and pointerdown lets the
    // outside-check settle before anything else reacts.
    function onOutside(event: Event): void {
      const node = wrapRef.current;
      if (node !== null && !node.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
    };
  }, [open]);

  return (
    <div className="nav-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="nav-menu-button"
        ref={buttonRef}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        {t('nav.more')}
      </button>
      {open ? (
        <div
          className="nav-menu"
          id={panelId}
          role="group"
          aria-label={t('nav.moreTitle')}
          onClick={(event) => {
            // Any link inside navigates; a panel still covering the bar after
            // the route changed is chrome the reader has to dismiss by hand.
            if ((event.target as HTMLElement).closest('a') !== null) close();
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/* --- the desktop bar ----------------------------------------------------- */

function DesktopNav({ viewer, unread }: { viewer: Viewer | null; unread: number }): ReactNode {
  const t = useT();
  return (
    <nav className="shell-nav" aria-label={t('nav.label')}>
      <div className="nav-bar">
        {/* The product name, not a translatable string. */}
        <strong>DuckOJ</strong>
        {/* Cluster 1 — the work. Ordered by how often a pupil wants it, and
            `Tổ chức` last because it is where a teacher lives. */}
        <div className="nav-group nav-main" role="group" aria-label={t('nav.groupMain')}>
          <Link to="/problems">{t('nav.problems')}</Link>
          <Link to="/contests">{t('nav.contests')}</Link>
          <Link to="/submissions">{t('nav.submissions')}</Link>
          <Link to="/orgs">{t('nav.orgs')}</Link>
        </div>
        {/* Cluster 2 — reference. `/api/v1/docs` stays a plain <a>: it is
            Scalar's own page, entirely outside this router's tree, and a
            <Link> there would have nothing to resolve. The student guide is
            ungated on purpose — it is most needed by someone who has not
            signed in yet, and the first thing it explains is how to
            register. Admin sits here rather than in the account cluster:
            it is a place in the app, not a setting on the person. */}
        <div className="nav-group nav-resources" role="group" aria-label={t('nav.groupResources')}>
          <Link to="/help">{t('nav.help')}</Link>
          <a href="/api/v1/docs">{t('nav.api')}</a>
          {viewer?.isAdmin ? <Link to="/admin">{t('nav.admin')}</Link> : null}
        </div>
        {/* Cluster 3 — the person. Pushed to the right rail, so "the app" and
            "me" are two places on this bar rather than one queue. */}
        <div className="nav-group nav-account" role="group" aria-label={t('nav.groupAccount')}>
          {viewer ? (
            <>
              <Link
                to="/notifications"
                className="nav-bell"
                aria-label={t('nav.notifications', { count: unread })}
              >
                <NavIcon name="bell" />
                <BellBadge unread={unread} />
              </Link>
              <Link
                to="/users/$username"
                params={{ username: viewer.username }}
                className="nav-me avatar-name"
              >
                {/* Decorative — the name is right here, so the avatar is
                    aria-hidden and the link's accessible name stays the name. */}
                <Avatar name={viewer.displayName} size={20} />
                {viewer.displayName}
              </Link>
              <AccountMenu>
                <Link to="/me/progress">{t('nav.progress')}</Link>
                <Link to="/account/settings">{t('nav.settings')}</Link>
                <Link to="/account/security">{t('nav.security')}</Link>
                <Link to="/account/tokens">{t('nav.tokens')}</Link>
                <Link to="/account/password">{t('nav.password')}</Link>
                <ThemeToggle />
              </AccountMenu>
              {/* The language switch never collapses (D18): a reader who
                  cannot read Vietnamese must not have to find a Vietnamese
                  word in order to escape Vietnamese. */}
              <LocaleToggle />
              <SignOutButton />
            </>
          ) : (
            <>
              <Link to="/">{t('nav.signIn')}</Link>
              <Link to="/register">{t('nav.register')}</Link>
              <LocaleToggle />
              <ThemeToggle />
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

/* --- the phone: five tabs and a sheet ------------------------------------ */

/** Everything focusable a trap has to cycle through. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The overflow sheet.
 *
 * A real modal, not a disclosure: it covers the page, so it takes the focus
 * ring with it. Escape closes it (listened for on the document, because a
 * click on the backdrop leaves focus on <body> and a container-scoped
 * listener would then be deaf), the backdrop closes it, Tab cycles inside
 * it, and closing returns focus to the button that opened it — losing focus
 * to the top of the document is how a keyboard reader ends up re-walking the
 * whole page after every dismissal.
 *
 * It renders as a SIBLING of `<nav class="shell-nav">`, never inside it:
 * `.shell-nav` carries a `backdrop-filter`, which makes it the containing
 * block for `position: fixed` descendants — a full-screen backdrop nested in
 * it would be clamped to the bar's own 56px box.
 */
function MoreSheet({
  id,
  onClose,
  children,
}: {
  id: string;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const t = useT();
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = sheetRef.current;
    node?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  function trapTab(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Tab') return;
    const node = sheetRef.current;
    if (!node) return;
    const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="nav-sheet-layer">
      {/* A <button>, not a div with an onClick: a dismiss target is a
          control, and a control has a role. Hidden from the accessibility
          tree and out of the tab order all the same — it is a POINTER
          convenience that duplicates the named close button below, and two
          controls called "Đóng" is one more than a screen reader can tell
          apart. Not focusable, so `aria-hidden` here hides nothing reachable. */}
      <button
        type="button"
        className="nav-sheet-backdrop"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className="nav-sheet"
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.moreTitle')}
        ref={sheetRef}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <div className="nav-sheet-head">
          <h2>{t('nav.moreTitle')}</h2>
          <button type="button" className="nav-sheet-close" onClick={onClose}>
            {t('nav.close')}
          </button>
        </div>
        <div className="nav-sheet-items">{children}</div>
      </div>
    </div>
  );
}

function PhoneNav({ viewer, unread }: { viewer: Viewer | null; unread: number }): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const sheetId = useId();

  // `useCallback`-free on purpose: `close` is passed to `MoreSheet`'s
  // `onClose` effect dependency, and the effect it feeds only adds and
  // removes a document listener — re-running it on a re-render is free and
  // cannot miss a key.
  function close(): void {
    setOpen(false);
    moreRef.current?.focus();
  }

  return (
    <>
      <nav className="shell-nav shell-nav-phone" aria-label={t('nav.label')}>
        <div className="nav-tabs">
          <Link to="/problems" className="nav-tab">
            <NavIcon name="problems" />
            <span>{t('nav.problems')}</span>
          </Link>
          <Link to="/contests" className="nav-tab">
            <NavIcon name="contests" />
            <span>{t('nav.contests')}</span>
          </Link>
          <Link to="/submissions" className="nav-tab">
            <NavIcon name="submissions" />
            <span>{t('nav.submissions')}</span>
          </Link>
          {/* The fourth tab is the bell for a member and the way in for a
              visitor: a bell with nothing behind it is a dead tab, and
              signing in is the only thing a signed-out visitor is here to
              do that is not already a tab. */}
          {viewer ? (
            <Link
              to="/notifications"
              className="nav-tab nav-tab-bell"
              aria-label={t('nav.notifications', { count: unread })}
            >
              <span className="nav-tab-glyph">
                <NavIcon name="bell" />
                <BellBadge unread={unread} />
              </span>
              <span>{t('nav.notificationsTab')}</span>
            </Link>
          ) : (
            <Link to="/" className="nav-tab">
              <NavIcon name="signIn" />
              <span>{t('nav.signIn')}</span>
            </Link>
          )}
          <button
            type="button"
            className="nav-tab nav-more"
            ref={moreRef}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={sheetId}
            onClick={() => {
              setOpen((was) => !was);
            }}
          >
            <NavIcon name="more" />
            <span>{t('nav.more')}</span>
          </button>
        </div>
      </nav>
      {open ? (
        <MoreSheet id={sheetId} onClose={close}>
          {/* Every item closes the sheet on the way out: a sheet still
              covering the page after the route under it changed is a page
              the reader cannot see. */}
          <Link to="/orgs" onClick={close}>
            {t('nav.orgs')}
          </Link>
          {viewer ? (
            <>
              <Link
                to="/users/$username"
                params={{ username: viewer.username }}
                className="nav-me avatar-name"
                onClick={close}
              >
                <Avatar name={viewer.displayName} size={20} />
                {viewer.displayName}
              </Link>
              <Link to="/me/progress" onClick={close}>
                {t('nav.progress')}
              </Link>
              <Link to="/account/settings" onClick={close}>
                {t('nav.settings')}
              </Link>
              <Link to="/account/security" onClick={close}>
                {t('nav.security')}
              </Link>
              <Link to="/account/tokens" onClick={close}>
                {t('nav.tokens')}
              </Link>
              <Link to="/account/password" onClick={close}>
                {t('nav.password')}
              </Link>
            </>
          ) : (
            <Link to="/register" onClick={close}>
              {t('nav.register')}
            </Link>
          )}
          {viewer?.isAdmin ? (
            <Link to="/admin" onClick={close}>
              {t('nav.admin')}
            </Link>
          ) : null}
          <Link to="/help" onClick={close}>
            {t('nav.help')}
          </Link>
          <a href="/api/v1/docs">{t('nav.api')}</a>
          <LocaleToggle />
          <ThemeToggle />
          {viewer ? <SignOutButton /> : null}
        </MoreSheet>
      ) : null}
    </>
  );
}

/**
 * The nav bar itself, split out of `RootComponent` so `test/i18n.spec.tsx`
 * can render the REAL nav — every link label and the real language toggle —
 * rather than a hand-built stand-in that could drift from it. `RootComponent`
 * is untestable on its own: its `<Outlet />` needs a matched route, which
 * `RouterContextProvider` (the pattern every other spec in this suite uses)
 * deliberately does not supply.
 */
export function ShellNav(): ReactNode {
  const phone = usePhoneLayout();
  const { viewer, unread } = useViewer();
  return phone ? (
    <PhoneNav viewer={viewer} unread={unread} />
  ) : (
    <DesktopNav viewer={viewer} unread={unread} />
  );
}

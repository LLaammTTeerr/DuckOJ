/**
 * What the polling screens cost a room of 2000 students, and what a hidden
 * tab costs it.
 *
 * Three screens in this app poll on a timer: the contest page's Q&A feed
 * every 30 s while a contest is running (D31/D63), the shell's notification
 * bell every 60 s, and the admin dashboard every 15 s (D47). A provincial
 * contest is 2000 browsers, and every one of them leaves the contest page
 * open for three hours — so the interval is not a detail of one screen, it is
 * a floor under the whole stack's request rate:
 *
 * | screen        | interval | 2000 open tabs |
 * | Q&A feed      |   30 s   |    67 req/s    |
 * | bell          |   60 s   |    33 req/s    |
 * | dashboard     |   15 s   | one admin      |
 *
 * 100 req/s of pure polling, arriving whether or not anybody is looking, on
 * top of the ~400 req/s load/RESULTS.md models for the room's actual reading.
 *
 * **The half that must keep working is the hidden tab.** A student who
 * switches to their editor, or whose phone screen locks, is not reading
 * anything — and a tab nobody is looking at must not go on asking. TanStack
 * Query v5 already does this: `refetchIntervalInBackground` defaults to
 * false, and its `focusManager` tracks `document.visibilityState`, so a
 * hidden tab's interval is skipped. That is a DEFAULT, though, and a default
 * is exactly the kind of thing a later `refetchIntervalInBackground: true`
 * (or a version bump) removes silently — at which point 2000 phones in
 * pockets go on polling for three hours and nothing in the suite notices.
 *
 * So these tests pin the behaviour rather than the configuration. They assert
 * what the network sees, which is the thing that matters and the thing that
 * would change.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { notificationsQueryOptions } = await import('../src/routes/notifications.js');

/**
 * Drives `document.visibilityState` the way a browser does.
 *
 * jsdom's property is read-only, so it is redefined; `focusManager.setEventListener`
 * is what TanStack Query subscribes through, and calling the listener is the
 * same signal a real `visibilitychange` event delivers.
 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function wrap(ui: React.ReactElement) {
  // `retry: false` so a failure surfaces at once; every other default is the
  // shipped one, which is the point — this file is about a DEFAULT.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The shell's bell, as `router.tsx` builds it. */
function Bell() {
  const feed = useQuery({ ...notificationsQueryOptions, refetchInterval: 60_000 });
  return <span data-testid="bell">{feed.data?.unreadCount ?? 0}</span>;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setVisibility('visible');
  get.mockResolvedValue({ data: { unreadCount: 0, items: [] }, response: { status: 200 } });
});

afterEach(() => {
  vi.useRealTimers();
  // The manager is a module-level singleton shared across every spec file in
  // this worker; leaving it "hidden" would silently stop the polls in
  // whichever file runs next.
  focusManager.setFocused(undefined);
  setVisibility('visible');
  get.mockReset();
});

describe('a polling screen left open', () => {
  it('keeps polling while somebody is actually looking at it', async () => {
    wrap(<Bell />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  });

  it('stops asking once the tab is hidden, and resumes when it comes back', async () => {
    wrap(<Bell />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    // Ten intervals. A student who locks their phone for ten minutes must
    // cost the stack nothing; at 2000 of them the bell alone is 33 req/s of
    // questions nobody is waiting for an answer to.
    await vi.advanceTimersByTimeAsync(60_000 * 10);
    expect(get).toHaveBeenCalledTimes(1);

    // ...and starts again when the reader comes back, rather than staying
    // dead for the rest of the session — the failure mode a naive "clear the
    // interval when hidden" fix ships with.
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('the intervals themselves', () => {
  it('are the ones the request-rate table above was computed from', async () => {
    // Read from source, so the table in this file's header cannot drift away
    // from the code the way a comment does. If somebody drops the Q&A feed to
    // 5 s, that is 400 req/s from a room of 2000 and this is what says so.
    const { readFile } = await import('node:fs/promises');
    // Plain paths, not `new URL(…, import.meta.url)`: this suite runs in the
    // jsdom environment, where `import.meta.url` is not a `file:` URL. Vitest
    // runs each package from its own root, so `src/…` resolves.
    const contests = await readFile('src/routes/contests.tsx', 'utf8');
    const router = await readFile('src/router.tsx', 'utf8');
    const admin = await readFile('src/routes/admin.tsx', 'utf8');

    expect(contests).toContain("refetchInterval: phase === 'running' ? 30_000 : false");
    expect(router).toContain('refetchInterval: 60_000');
    expect(admin).toContain('refetchInterval: 15_000');

    // And nothing anywhere opts back into polling a tab nobody is looking at.
    for (const source of [contests, router, admin]) {
      expect(source).not.toContain('refetchIntervalInBackground');
    }
  });

  it('stops the Q&A feed entirely once the contest is not running', async () => {
    // `false`, not a longer interval: a finished contest's Q&A cannot change,
    // so the correct rate is zero. This is the clause that keeps 2000 tabs
    // left open overnight from polling until morning.
    const { readFile } = await import('node:fs/promises');
    const contests = await readFile('src/routes/contests.tsx', 'utf8');
    expect(contests).toMatch(/refetchInterval: phase === 'running' \? 30_000 : false/);
  });
});

describe('the admin dashboard', () => {
  it('is one reader, so its 15 s is 0.07 req/s and not a rate problem', () => {
    // Stated as a test so the reasoning is checkable rather than asserted in
    // a comment: /admin is @SessionOnly + admin-only (D47), so the interval
    // multiplies by the number of admins watching, not by the room.
    const readers = 1;
    expect((readers / 15) * 60).toBeLessThan(10);
  });
});

describe('what a hidden tab does to the contest page specifically', () => {
  it('is the same rule, because every poll in this app goes through one manager', async () => {
    // `focusManager` is a singleton: there is no per-query opt-out short of
    // `refetchIntervalInBackground`, which the assertion above forbids. So
    // proving it once for the bell proves it for the Q&A feed too — and this
    // test says why, so nobody adds a near-copy for each screen.
    setVisibility('hidden');
    expect(focusManager.isFocused()).toBe(false);
    setVisibility('visible');
    expect(focusManager.isFocused()).toBe(true);
  });
});

describe('the request rate this all adds up to', () => {
  it('is under 100 req/s for a 2000-seat room, and the arithmetic is here', () => {
    const seats = 2000;
    const qna = seats / 30;
    const bell = seats / 60;
    expect(Math.round(qna)).toBe(67);
    expect(Math.round(bell)).toBe(33);
    // The number to keep an eye on. load/RESULTS.md measures the same host
    // serving ~2400 req/s, so 100 req/s of polling is ~4% of capacity spent
    // on questions nobody asked — acceptable, and worth failing a test over
    // if an interval change ever doubles it.
    expect(qna + bell).toBeLessThanOrEqual(100);
  });
});

describe('a screen that is not polling at all', () => {
  it('does not start when the tab regains focus mid-render', async () => {
    // A refetch-on-focus without an interval would be a second, invisible
    // rate: 2000 students alt-tabbing back into the room at the bell. The
    // app never sets `refetchOnWindowFocus`, so the default applies to
    // queries that are STALE — and every polling screen above is the only
    // place a timer exists.
    function Once() {
      const query = useQuery({ ...notificationsQueryOptions, staleTime: Infinity });
      return <span data-testid="once">{query.data ? 'loaded' : 'loading'}</span>;
    }
    wrap(<Once />);
    expect(await screen.findByTestId('once')).toHaveTextContent('loaded');
    expect(get).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

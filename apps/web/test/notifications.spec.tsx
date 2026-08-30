import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { NotificationsPage, notificationsQueryOptions } = await import(
  '../src/routes/notifications.js',
);

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * A stand-in for the shell's bell.
 *
 * `router.tsx`'s `ShellNav` renders the count from
 * `useQuery({ ...notificationsQueryOptions, enabled, refetchInterval })` —
 * this reads the SAME options object, so it shares the same
 * `['notifications']` cache entry and answers the question the real bell
 * would: does the unread count in the nav clear when the page marks
 * everything read, or does it linger until the next sixty-second poll?
 * Rendering the real `ShellNav` here would drag in the whole route tree.
 */
function Bell() {
  const feed = useQuery(notificationsQueryOptions);
  return <span data-testid="bell">{feed.data?.unreadCount ?? 0}</span>;
}

const FEED = {
  unreadCount: 1,
  items: [
    {
      id: 3,
      kind: 'org_join_decided',
      payload: { orgSlug: 'hanoi', approved: true },
      readAt: null,
      createdAt: '2026-08-01T00:00:00Z',
    },
    {
      id: 25,
      kind: 'org_join_decided',
      payload: { orgSlug: 'hue', approved: false },
      readAt: '2026-07-02T00:00:00Z',
      createdAt: '2026-07-01T12:00:00Z',
    },
    {
      id: 2,
      kind: 'role_granted',
      payload: { globalRole: 'setter' },
      readAt: '2026-07-02T00:00:00Z',
      createdAt: '2026-07-01T00:00:00Z',
    },
    {
      id: 1,
      kind: 'a_kind_from_the_future',
      payload: {},
      readAt: '2026-07-02T00:00:00Z',
      createdAt: '2026-06-01T00:00:00Z',
    },
  ],
};

afterEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('NotificationsPage', () => {
  it('renders each known kind as a sentence, and an unknown kind by its name', async () => {
    get.mockResolvedValue({ data: FEED });
    wrap(<NotificationsPage />);

    expect(await screen.findByText(/đã được duyệt/)).toBeInTheDocument();
    expect(screen.getByText(/đã bị từ chối/)).toBeInTheDocument();
    expect(screen.getByText(/Bạn hiện có quyền người ra đề/)).toBeInTheDocument();
    // The fallback: never a blank row for a kind this file has not learned.
    expect(screen.getByText('a_kind_from_the_future')).toBeInTheDocument();
  });

  it('marks the unread row in strong weight, not the read one', async () => {
    get.mockResolvedValue({ data: FEED });
    wrap(<NotificationsPage />);
    const unread = await screen.findByText(/đã được duyệt/);
    expect(unread.closest('strong')).not.toBeNull();
    expect(screen.getByText(/Bạn hiện có quyền người ra đề/).closest('strong')).toBeNull();
  });

  it('mark-all-read posts, then trusts the response it got back', async () => {
    get.mockResolvedValue({ data: FEED });
    post.mockResolvedValue({
      data: { ...FEED, unreadCount: 0, items: FEED.items.map((i) => ({ ...i, readAt: '2026-08-02T00:00:00Z' })) },
    });
    wrap(<NotificationsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Đánh dấu đã đọc tất cả \(1\)/ }));
    expect(post).toHaveBeenCalledWith('/notifications/read');
    // The button keys off unreadCount, which the response zeroed.
    expect(screen.queryByRole('button')).toBeNull();
  });

  // `markAllRead` was the one write in this app with no busy flag, no
  // try/catch and no error branch — a shape every other handler here follows
  // (see contests.tsx's `patchRow`). openapi-fetch RETHROWS network-level
  // failures rather than resolving them to `{ error }`, so a click during an
  // outage produced an unhandled promise rejection and a button that looked
  // like it had simply done nothing.
  it('says so when the mark-all-read request fails on the network', async () => {
    get.mockResolvedValue({ data: FEED });
    post.mockRejectedValue(new TypeError('Failed to fetch'));
    wrap(<NotificationsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Đánh dấu đã đọc tất cả/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không kết nối được/i);
    // The unread rows are still unread — nothing was optimistically zeroed.
    expect(screen.getByRole('button', { name: /Đánh dấu đã đọc tất cả \(1\)/ })).toBeEnabled();
  });

  it('says so when the server refuses the mark-all-read', async () => {
    get.mockResolvedValue({ data: FEED });
    post.mockResolvedValue({ data: undefined, error: { detail: 'Not signed in.' } });
    wrap(<NotificationsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Đánh dấu đã đọc tất cả/ }));
    // The server's own wording, verbatim (D18).
    expect(await screen.findByRole('alert')).toHaveTextContent(/Not signed in/i);
  });

  it('holds the button down while the request is in flight, so one click is one post', async () => {
    get.mockResolvedValue({ data: FEED });
    let release: (value: unknown) => void = () => undefined;
    post.mockReturnValue(new Promise((resolve) => (release = resolve)));
    wrap(<NotificationsPage />);

    const button = await screen.findByRole('button', { name: /Đánh dấu đã đọc tất cả/ });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(post).toHaveBeenCalledTimes(1);

    release({ data: { ...FEED, unreadCount: 0 } });
  });

  it("clears the shell bell's unread count, not just the rows on the page", async () => {
    get.mockResolvedValue({ data: FEED });
    post.mockResolvedValue({
      data: {
        ...FEED,
        unreadCount: 0,
        items: FEED.items.map((i) => ({ ...i, readAt: '2026-08-02T00:00:00Z' })),
      },
    });
    wrap(
      <>
        <Bell />
        <NotificationsPage />
      </>,
    );

    // `findByTestId` would resolve on the first paint, when the query has not
    // answered yet and the bell honestly reads 0 — `waitFor` is what makes
    // this assert the loaded state rather than the empty one.
    await waitFor(() => expect(screen.getByTestId('bell')).toHaveTextContent('1'));
    await userEvent.click(await screen.findByRole('button', { name: /Đánh dấu đã đọc tất cả/ }));
    await waitFor(() => expect(screen.getByTestId('bell')).toHaveTextContent('0'));
  });

  it('tells a signed-out viewer to sign in rather than erroring', async () => {
    get.mockResolvedValue({ data: undefined, error: { detail: 'Not signed in.' } });
    wrap(<NotificationsPage />);
    expect(await screen.findByText(/Đăng nhập để xem thông báo/)).toBeInTheDocument();
  });
});

/**
 * D31's three kinds. The point of pinning them here is the fallback: a kind
 * the switch does not know renders as its own raw name (`a_kind_from_the_
 * future` above), which is fine for a kind the server grew yesterday and a
 * bug for one this app ships.
 */
describe('contest clarification notifications', () => {
  const CONTEST_FEED = {
    unreadCount: 3,
    items: [
      {
        id: 30,
        kind: 'clarification_answered',
        payload: { contestKey: 'spring', contestName: 'Spring Open', clarificationId: 7 },
        readAt: null,
        createdAt: '2026-08-01T00:00:00Z',
      },
      {
        id: 29,
        kind: 'clarification_published',
        payload: { contestKey: 'spring', contestName: 'Spring Open', clarificationId: 7 },
        readAt: null,
        createdAt: '2026-08-01T00:00:00Z',
      },
      {
        id: 28,
        kind: 'contest_announcement',
        payload: { contestKey: 'spring', contestName: 'Spring Open', clarificationId: 8 },
        readAt: null,
        createdAt: '2026-08-01T00:00:00Z',
      },
    ],
  };

  it('reads each as a sentence around a link to the contest, never as a raw kind', async () => {
    get.mockResolvedValue({ data: CONTEST_FEED });
    wrap(<NotificationsPage />);

    expect(await screen.findByText(/Câu hỏi của bạn ở/)).toBeInTheDocument();
    expect(screen.getByText(/Có câu hỏi được công bố ở/)).toBeInTheDocument();
    expect(screen.getByText(/Thông báo mới ở/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Spring Open' })).toHaveLength(3);
    expect(screen.queryByText('clarification_answered')).toBeNull();
    expect(screen.queryByText('contest_announcement')).toBeNull();
  });
});

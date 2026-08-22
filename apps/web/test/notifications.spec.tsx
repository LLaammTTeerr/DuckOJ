import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { NotificationsPage } = await import('../src/routes/notifications.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
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

    expect(await screen.findByText(/was approved/i)).toBeInTheDocument();
    expect(screen.getByText(/was declined/i)).toBeInTheDocument();
    expect(screen.getByText(/you are now a setter/i)).toBeInTheDocument();
    // The fallback: never a blank row for a kind this file has not learned.
    expect(screen.getByText('a_kind_from_the_future')).toBeInTheDocument();
  });

  it('marks the unread row in strong weight, not the read one', async () => {
    get.mockResolvedValue({ data: FEED });
    wrap(<NotificationsPage />);
    const unread = await screen.findByText(/was approved/i);
    expect(unread.closest('strong')).not.toBeNull();
    expect(screen.getByText(/you are now a setter/i).closest('strong')).toBeNull();
  });

  it('mark-all-read posts, then trusts the response it got back', async () => {
    get.mockResolvedValue({ data: FEED });
    post.mockResolvedValue({
      data: { ...FEED, unreadCount: 0, items: FEED.items.map((i) => ({ ...i, readAt: '2026-08-02T00:00:00Z' })) },
    });
    wrap(<NotificationsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /mark all read \(1\)/i }));
    expect(post).toHaveBeenCalledWith('/notifications/read');
    // The button keys off unreadCount, which the response zeroed.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('tells a signed-out viewer to sign in rather than erroring', async () => {
    get.mockResolvedValue({ data: undefined, error: { detail: 'Not signed in.' } });
    wrap(<NotificationsPage />);
    expect(await screen.findByText(/sign in to see notifications/i)).toBeInTheDocument();
  });
});

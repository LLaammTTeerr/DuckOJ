/**
 * The admin panel. The gate test matters most: the panel renders nothing
 * actionable for a non-admin — cosmetic (the API re-decides), but a setter
 * seeing Rate buttons that all 403 would reasonably file it as a bug.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    PATCH: (...a: unknown[]) => patch(...a),
  },
}));

const { AdminPage } = await import('../src/routes/admin.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const CONTEST = {
  id: 1,
  key: 'spring',
  name: 'Spring Open',
  startTime: '2026-03-01T09:00:00Z',
  endTime: '2026-03-01T14:00:00Z',
  format: 'icpc',
  visibility: 'public',
  pointsPrecision: 3,
  frozenLastMinutes: 0,
  timeLimitSeconds: null,
  isRated: false,
  createdAt: '2026-02-01T00:00:00Z',
};

function serve(role: string, contests = [CONTEST]) {
  get.mockImplementation((path: string) => {
    if (path === '/auth/me') return Promise.resolve({ data: { username: 'root', displayName: 'Root', globalRole: role } });
    if (path === '/contests') return Promise.resolve({ data: { items: contests, nextCursor: null } });
    return Promise.resolve({ data: undefined });
  });
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
});

describe('AdminPage', () => {
  it('shows a setter nothing but "Admins only"', async () => {
    serve('setter');
    wrap(<AdminPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/admins only/i);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('grants a role and reports what the server actually granted', async () => {
    serve('admin');
    patch.mockResolvedValue({ data: { id: 2, username: 'kim', globalRole: 'setter' } });
    wrap(<AdminPage />);

    await userEvent.type(await screen.findByLabelText(/username/i), 'kim');
    await userEvent.click(screen.getByRole('button', { name: /grant/i }));
    expect(patch).toHaveBeenCalledWith('/admin/users/{username}', {
      params: { path: { username: 'kim' } },
      body: { globalRole: 'setter' },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('kim is now setter.');
  });

  it('refuses to grant with an empty username', async () => {
    serve('admin');
    wrap(<AdminPage />);
    expect(await screen.findByRole('button', { name: /grant/i })).toBeDisabled();
  });

  it('rates an unrated contest and shows how far the replay reached', async () => {
    serve('admin');
    post.mockResolvedValue({ data: { contestsRated: 7 } });
    wrap(<AdminPage />);

    await userEvent.click(await screen.findByRole('button', { name: /^rate$/i }));
    expect(post).toHaveBeenCalledWith('/admin/contests/{key}/rate', {
      params: { path: { key: 'spring' } },
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/7 contests now feed ratings/i);
  });

  it('offers Unrate — not Rate — for a contest that is already rated', async () => {
    serve('admin', [{ ...CONTEST, isRated: true }]);
    wrap(<AdminPage />);
    expect(await screen.findByRole('button', { name: /unrate/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^rate$/i })).toBeNull();
  });

  it('surfaces the API detail when a grant is refused', async () => {
    serve('admin');
    patch.mockResolvedValue({ error: { detail: 'You cannot remove your own admin role.' } });
    wrap(<AdminPage />);
    await userEvent.type(await screen.findByLabelText(/username/i), 'root');
    await userEvent.click(screen.getByRole('button', { name: /grant/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/your own admin role/i);
  });
});

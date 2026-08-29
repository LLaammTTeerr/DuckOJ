/**
 * The organization screens' load-bearing branches: what each role is offered.
 *
 * Everything here rides on one derivation — the viewer's standing is their
 * row in the members list, not a separate endpoint — so the fixtures vary
 * that row and assert what appears: a stranger gets Join, a member gets
 * Leave, a decider gets the queue and the role controls, and an
 * invite-only organization offers a stranger nothing at all.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const patch = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    DELETE: (...a: unknown[]) => del(...a),
    PATCH: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { OrgPage, OrgsPage } = await import('../src/routes/orgs.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ORG = {
  id: 1,
  slug: 'hanoi',
  name: 'Hanoi CS',
  about: null,
  visibility: 'public',
  joinPolicy: 'request',
  createdAt: '2026-01-01T00:00:00Z',
};

const MEMBERS = [
  { username: 'owner-person', role: 'owner', joinedAt: '2026-01-01T00:00:00Z' },
  { username: 'plain-person', role: 'member', joinedAt: '2026-01-02T00:00:00Z' },
];

/** Wires GET for a viewer signed in as `username` (or nobody, with null). */
function serve(username: string | null, org = ORG, members = MEMBERS, requests: unknown[] = []) {
  get.mockImplementation((path: string) => {
    if (path === '/auth/me')
      return Promise.resolve({ data: username === null ? undefined : { username, displayName: username } });
    if (path === '/orgs/{slug}') return Promise.resolve({ data: org });
    if (path === '/orgs/{slug}/members') return Promise.resolve({ data: members });
    if (path === '/orgs/{slug}/requests') return Promise.resolve({ data: requests });
    return Promise.resolve({ data: undefined });
  });
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
  patch.mockReset();
});

describe('OrgsPage', () => {
  it('lists organizations with their join policy in words', async () => {
    get.mockResolvedValue({ data: { items: [ORG], nextCursor: null } });
    wrap(<OrgsPage />);
    expect(await screen.findByText('Hanoi CS')).toBeInTheDocument();
    expect(screen.getByText('cần duyệt')).toBeInTheDocument();
  });

  it('offers the create form to an admin and nobody else', async () => {
    get.mockImplementation((path: string) =>
      path === '/auth/me'
        ? Promise.resolve({ data: { username: 'root', displayName: 'Root', globalRole: 'admin' } })
        : Promise.resolve({ data: { items: [], nextCursor: null } }),
    );
    wrap(<OrgsPage />);
    expect(await screen.findByRole('heading', { name: /^Tổ chức mới$/ })).toBeInTheDocument();

    get.mockImplementation((path: string) =>
      path === '/auth/me'
        ? Promise.resolve({ data: { username: 'kim', displayName: 'Kim', globalRole: 'setter' } })
        : Promise.resolve({ data: { items: [], nextCursor: null } }),
    );
    wrap(<OrgsPage />);
    await screen.findByText(/Chưa có tổ chức nào/);
    expect(screen.queryAllByRole('heading', { name: /^Tổ chức mới$/ })).toHaveLength(1);
  });

  it('creates through the API with the chosen policy', async () => {
    get.mockImplementation((path: string) =>
      path === '/auth/me'
        ? Promise.resolve({ data: { username: 'root', displayName: 'Root', globalRole: 'admin' } })
        : Promise.resolve({ data: { items: [], nextCursor: null } }),
    );
    post.mockResolvedValue({ data: ORG });
    wrap(<OrgsPage />);
    await userEvent.type(await screen.findByLabelText(/^Định danh$/), 'hanoi');
    await userEvent.type(screen.getByLabelText(/^Tên$/), 'Hanoi CS');
    await userEvent.selectOptions(screen.getByLabelText(/^Cách gia nhập$/), 'open');
    await userEvent.click(screen.getByRole('button', { name: /^Tạo$/ }));
    expect(post).toHaveBeenCalledWith('/orgs', {
      body: { slug: 'hanoi', name: 'Hanoi CS', joinPolicy: 'open', visibility: 'public' },
    });
  });
});

describe('OrgPage', () => {
  it('offers a stranger "Request to join" under a request policy, and reports the request', async () => {
    serve('stranger');
    post.mockResolvedValue({ data: { outcome: 'requested', role: null } });
    wrap(<OrgPage slug="hanoi" />);

    const button = await screen.findByRole('button', { name: /^Xin gia nhập$/ });
    await userEvent.click(button);
    expect(post).toHaveBeenCalledWith('/orgs/{slug}/join', { params: { path: { slug: 'hanoi' } } });
    expect(await screen.findByText(/Đã gửi yêu cầu/)).toBeInTheDocument();
    // Nothing joined, so the button must not be replaced by member controls.
    expect(screen.queryByRole('button', { name: /^Rời khỏi$/ })).toBeNull();
  });

  it('offers a stranger nothing on an invite-only organization', async () => {
    serve('stranger', { ...ORG, joinPolicy: 'invite' });
    wrap(<OrgPage slug="hanoi" />);
    await screen.findByText('Hanoi CS');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /gia nhập/i })).toBeNull();
    });
  });

  it('offers an anonymous viewer no join at all', async () => {
    serve(null);
    wrap(<OrgPage slug="hanoi" />);
    await screen.findByText('Hanoi CS');
    expect(screen.queryByRole('button', { name: /gia nhập/i })).toBeNull();
  });

  it('a plain member may leave, and only leave', async () => {
    serve('plain-person');
    wrap(<OrgPage slug="hanoi" />);
    expect(await screen.findByRole('button', { name: /^Rời khỏi$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Xóa$/ })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('a decider sees the queue and can approve into the roster', async () => {
    serve('owner-person', ORG, MEMBERS, [{ id: 7, username: 'hopeful', createdAt: '2026-02-01T00:00:00Z' }]);
    post.mockResolvedValue({ data: MEMBERS });
    wrap(<OrgPage slug="hanoi" />);

    const approve = await screen.findByRole('button', { name: /^Duyệt$/ });
    await userEvent.click(approve);
    expect(post).toHaveBeenCalledWith('/orgs/{slug}/requests/{id}/approve', {
      params: { path: { slug: 'hanoi', id: 7 } },
    });
  });

  it("a decider changes another member's role but never their own", async () => {
    serve('owner-person');
    patch.mockResolvedValue({ data: MEMBERS });
    wrap(<OrgPage slug="hanoi" />);

    const select = await screen.findByRole('combobox', { name: /Vai trò của plain-person/ });
    // Their own row has no select — demoting the last owner by mis-click is
    // the 409 the API answers, but the UI does not even offer it.
    expect(screen.queryByRole('combobox', { name: /Vai trò của owner-person/ })).toBeNull();
    await userEvent.selectOptions(select, 'admin');
    expect(patch).toHaveBeenCalledWith('/orgs/{slug}/members/{username}', {
      params: { path: { slug: 'hanoi', username: 'plain-person' } },
      body: { role: 'admin' },
    });
  });

  it('surfaces the API detail when a removal is refused', async () => {
    serve('owner-person');
    del.mockResolvedValue({ error: { detail: 'That would leave the organization with no owner.' } });
    wrap(<OrgPage slug="hanoi" />);
    const remove = await screen.findByRole('button', { name: /^Xóa$/ });
    await userEvent.click(remove);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no owner/i);
  });
});

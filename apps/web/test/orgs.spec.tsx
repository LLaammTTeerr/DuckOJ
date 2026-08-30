/**
 * The organization screens' load-bearing branches: what each role is offered.
 *
 * Everything here rides on one field — the organization row's `myRole`
 * (D58) — so the fixtures vary that field and assert what appears: a
 * stranger gets Join, a member gets Leave, a decider gets the queue and the
 * role controls, and an invite-only organization offers a stranger nothing
 * at all. It is deliberately NOT derived from the roster any more: the
 * roster is a page, and a member sorted past it used to read as an
 * outsider.
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

/**
 * Wires GET for a viewer signed in as `username` (or nobody, with null).
 *
 * `myRole` defaults to whatever `members` says about this viewer — which is
 * what the API computes — but a caller can override it on `org` to model the
 * case D58 exists for: a member who is NOT on the page of the roster the
 * screen has loaded.
 */
function serve(
  username: string | null,
  org: Record<string, unknown> = ORG,
  members = MEMBERS,
  requests: unknown[] = [],
) {
  const derived = members.find((m) => m.username === username)?.role ?? null;
  const orgRow = { ...org, myRole: 'myRole' in org ? org.myRole : derived };
  get.mockImplementation((path: string) => {
    if (path === '/auth/me')
      return Promise.resolve({ data: username === null ? undefined : { username, displayName: username } });
    if (path === '/orgs/{slug}') return Promise.resolve({ data: orgRow });
    if (path === '/orgs/{slug}/members')
      return Promise.resolve({ data: { items: members, nextCursor: null } });
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
    post.mockResolvedValue({ data: { items: MEMBERS, nextCursor: null } });
    wrap(<OrgPage slug="hanoi" />);

    const approve = await screen.findByRole('button', { name: /^Duyệt$/ });
    await userEvent.click(approve);
    expect(post).toHaveBeenCalledWith('/orgs/{slug}/requests/{id}/approve', {
      params: { path: { slug: 'hanoi', id: 7 } },
    });
  });

  it("a decider changes another member's role but never their own", async () => {
    serve('owner-person');
    patch.mockResolvedValue({ data: { items: MEMBERS, nextCursor: null } });
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

  it('still knows a member is a member when the roster page does not contain them (D58)', async () => {
    // The regression paginating the roster would otherwise have shipped: this
    // viewer holds `member`, but sorts past the page the screen has loaded.
    serve('offpage-person', { ...ORG, myRole: 'member' });
    wrap(<OrgPage slug="hanoi" />);
    await screen.findByText('Hanoi CS');
    expect(screen.queryByRole('button', { name: /gia nhập/i })).toBeNull();
  });

  it('pages the roster on demand rather than downloading it whole (D58)', async () => {
    get.mockImplementation((path: string, opts?: { params?: { query?: { cursor?: string } } }) => {
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'stranger', displayName: 'S' } });
      if (path === '/orgs/{slug}') return Promise.resolve({ data: { ...ORG, myRole: null } });
      if (path === '/orgs/{slug}/members') {
        return opts?.params?.query?.cursor === undefined
          ? Promise.resolve({ data: { items: [MEMBERS[0]], nextCursor: 'owner-person' } })
          : Promise.resolve({ data: { items: [MEMBERS[1]], nextCursor: null } });
      }
      return Promise.resolve({ data: [] });
    });
    wrap(<OrgPage slug="hanoi" />);

    expect(await screen.findByText('owner-person')).toBeInTheDocument();
    expect(screen.queryByText('plain-person')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Tải thêm$/ }));
    expect(await screen.findByText('plain-person')).toBeInTheDocument();
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

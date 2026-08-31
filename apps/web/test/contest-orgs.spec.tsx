/**
 * D56 on the web: the organizations a contest is restricted to — offered on
 * the two forms that set them, and named everywhere the contest is shown.
 *
 * The property that carries this file is the one a happy path cannot see: the
 * picker offers only what the API would ACCEPT (owner or admin), so a setter
 * cannot build a request that comes back 400, and an edit that touches
 * nothing else cannot silently drop a restriction the school relies on.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const navigate = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    PATCH: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => navigate,
  // D147's dirty guard hangs off the router; these pages render bare here.
  useBlocker: () => undefined,
}));

const { ContestNewPage } = await import('../src/routes/contest-new.js');
const { ContestEditPage } = await import('../src/routes/contest-edit.js');
const { ContestPage, ContestsPage } = await import('../src/routes/contests.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ORGS = {
  items: [
    { id: 1, slug: 'le-hong-phong', name: 'THPT Lê Hồng Phong', myRole: 'owner' },
    { id: 2, slug: 'tran-phu', name: 'THPT Trần Phú', myRole: 'admin' },
    // Merely a member: the API refuses this one, so the form must not offer it.
    { id: 3, slug: 'chu-van-an', name: 'THPT Chu Văn An', myRole: 'member' },
    { id: 4, slug: 'stranger', name: 'Somewhere Else', myRole: null },
  ],
};

const CONTEST = {
  id: 1,
  key: 'spring',
  name: 'Spring Open',
  startTime: new Date(Date.now() + 3_600_000).toISOString(),
  endTime: new Date(Date.now() + 7_200_000).toISOString(),
  format: 'icpc',
  visibility: 'public' as const,
  pointsPrecision: 3,
  frozenLastMinutes: 0,
  timeLimitSeconds: null,
  isRated: false,
  createdAt: new Date().toISOString(),
  formatConfig: null,
  canEdit: true,
  orgs: [{ slug: 'le-hong-phong', name: 'THPT Lê Hồng Phong' }],
  problems: [{ code: 'aplusb', name: 'A plus B', label: 'A', points: 100, partial: true, order: 0 }],
};

function routeGet(me: unknown, contest: unknown = CONTEST): void {
  get.mockImplementation((path: string) => {
    if (path === '/orgs') return Promise.resolve({ data: ORGS });
    if (path === '/auth/me') return Promise.resolve({ data: me });
    if (path === '/contests/{key}') return Promise.resolve({ data: contest });
    if (path === '/contests') return Promise.resolve({ data: { items: [contest], nextCursor: null } });
    if (path === '/contests/{key}/clarifications') return Promise.resolve({ data: { items: [] } });
    return Promise.resolve({ data: null });
  });
}

const SETTER = { id: 9, username: 'kim', displayName: 'Kim', globalRole: 'setter', locale: null, timezone: null };

afterEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  navigate.mockReset();
});

describe('the organization picker', () => {
  it('offers only the organizations the setter owns or administers', async () => {
    routeGet(SETTER);
    wrap(<ContestNewPage />);

    expect(await screen.findByLabelText(/Lê Hồng Phong/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Trần Phú/)).toBeInTheDocument();
    // A plain membership, and an organization they are not in at all: the
    // API answers `contest_org_unknown` for both, so offering them would be
    // offering a refusal.
    expect(screen.queryByLabelText(/Chu Văn An/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Somewhere Else/)).not.toBeInTheDocument();
  });

  /**
   * A failed `GET /orgs` says so, instead of claiming the setter belongs to
   * nothing.
   *
   * `openapi-fetch` does not throw on an HTTP error — it resolves with
   * `{ error, response }` — so a query function that reads only `data` never
   * rejects, `useQuery` never sees an error, and the picker's own error line
   * (which the file carries, with a comment explaining it) can never render.
   * What renders instead is `orgsNone`: "you do not own or administer any
   * organization", a false statement about the reader's own account, on the
   * one screen where acting on it means shipping a contest with no
   * restriction at all.
   */
  it('reports a failed organization load rather than an empty roster', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/orgs') {
        return Promise.resolve({ error: { detail: 'boom' }, response: { status: 500 } });
      }
      if (path === '/auth/me') return Promise.resolve({ data: SETTER });
      return Promise.resolve({ data: null });
    });
    wrap(<ContestNewPage />);

    expect(await screen.findByText(/Không tải được danh sách tổ chức/)).toBeInTheDocument();
    expect(screen.queryByText(/không sở hữu hay quản trị tổ chức nào/)).not.toBeInTheDocument();
  });

  it('offers every visible organization to a global admin', async () => {
    routeGet({ ...SETTER, globalRole: 'admin' });
    wrap(<ContestNewPage />);
    expect(await screen.findByLabelText(/Chu Văn An/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Somewhere Else/)).toBeInTheDocument();
  });

  it('sends the ticked slugs on create', async () => {
    routeGet(SETTER);
    post.mockResolvedValue({ data: { key: 'spring' } });
    wrap(<ContestNewPage />);

    await userEvent.type(screen.getByLabelText(/^Mã kỳ thi/), 'spring');
    await userEvent.type(screen.getByLabelText(/^Tên/), 'Spring Open');
    await userEvent.type(screen.getByLabelText(/Bắt đầu/), '2026-09-01T09:00');
    await userEvent.type(screen.getByLabelText(/Kết thúc/), '2026-09-01T14:00');
    await userEvent.click(await screen.findByLabelText(/Trần Phú/));
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));

    expect(post.mock.calls[0]![1].body.orgSlugs).toEqual(['tran-phu']);
  });

  it('prefills from the contest and sends the restriction back on an unrelated edit', async () => {
    routeGet(SETTER);
    patch.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);

    const ticked = await screen.findByLabelText(/Lê Hồng Phong/);
    expect(ticked).toBeChecked();
    expect(screen.getByLabelText(/Trần Phú/)).not.toBeChecked();

    // Only the NAME is touched. `orgSlugs` is replace-the-whole-set, so a
    // form that showed the restriction and then omitted it would delete it.
    await userEvent.type(screen.getByLabelText(/^Tên/), '!');
    await userEvent.click(screen.getByRole('button', { name: /Lưu/ }));
    expect(patch.mock.calls[0]![1].body.orgSlugs).toEqual(['le-hong-phong']);
  });

  it('unticking one and saving sends the set without it', async () => {
    routeGet(SETTER);
    patch.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);

    await userEvent.click(await screen.findByLabelText(/Lê Hồng Phong/));
    await userEvent.click(screen.getByRole('button', { name: /Lưu/ }));
    expect(patch.mock.calls[0]![1].body.orgSlugs).toEqual([]);
  });
});

describe('naming the restriction where the contest is shown', () => {
  it('names it on the contest page, so a refused join is readable', async () => {
    routeGet(SETTER);
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('heading', { name: /Spring Open/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'THPT Lê Hồng Phong' })).toBeInTheDocument();
  });

  it('names it on the list too', async () => {
    routeGet(SETTER);
    wrap(<ContestsPage />);
    expect(await screen.findByRole('link', { name: 'THPT Lê Hồng Phong' })).toBeInTheDocument();
  });

  it('says nothing at all about a contest nothing restricts', async () => {
    routeGet(SETTER, { ...CONTEST, orgs: [] });
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('heading', { name: /Spring Open/ })).toBeInTheDocument();
    expect(screen.queryByText(/Chỉ dành cho thành viên/)).not.toBeInTheDocument();
  });
});

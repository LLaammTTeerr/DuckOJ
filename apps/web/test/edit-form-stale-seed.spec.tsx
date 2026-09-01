/**
 * A save that reopens showing what it replaced (B-31, the invalidation class).
 *
 * `ProblemEditPage` and `ContestEditPage` are the two biggest
 * replace-the-whole-object forms in the app, and neither invalidated ANYTHING
 * after a successful save. On its own that is the ordinary cosmetic half of
 * this class — every screen reading `['problem', code]` or `['contest', key]`
 * renders the pre-save value until it happens to refetch.
 *
 * What makes it data loss is the seeding guard. Both forms prefill through a
 * `seededFrom` effect that runs ONCE per code/key and never runs again:
 *
 *     if (!query.data || seededFrom === query.data.code) return;
 *
 * That guard exists to stop a late refetch from clobbering what the setter has
 * typed, and it is right. But it means the FIRST value the form sees wins — and
 * on a remount that first value comes out of the cache synchronously, before
 * the mount's own refetch can land. So a form reopened within the cache's
 * lifetime seeds from the entry the save left stale, shows the pre-save
 * statement / problem list, and the next save PUTs it straight back. The
 * statement box holds the largest single thing anybody types into this site.
 *
 * Every existing spec for these two pages builds a FRESH `QueryClient` per
 * render, so its second mount is a cold cache and the bug is invisible. These
 * tests share one client across both mounts, which is what a browser does.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The untyped-spy shape `contest-edit.spec.tsx` and `teams-roster-refresh.spec.tsx`
// use, rather than `vi.mocked(api.PATCH)`: these mocks answer with a MUTABLE
// server object, and openapi-fetch's per-path response types cannot be
// satisfied by one implementation covering several routes.
const mockedGet = vi.fn();
const mockedPatch = vi.fn();
const { blocker, navigate } = vi.hoisted(() => ({ blocker: vi.fn(), navigate: vi.fn() }));
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => mockedGet(...a),
    POST: vi.fn(),
    PATCH: (...a: unknown[]) => mockedPatch(...a),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useBlocker: (...args: unknown[]) => blocker(...args) as unknown,
  useNavigate: () => navigate,
}));

const { ProblemEditPage } = await import('../src/routes/problem-edit.js');
const { ContestEditPage } = await import('../src/routes/contest-edit.js');

/**
 * ONE client for the whole walk, not one per render. This is the entire point:
 * a browser keeps its cache across a navigation away and back, and `gcTime`
 * defaults to five minutes — far longer than a setter takes to check their
 * work and come back for a typo.
 */
function walk(): { client: QueryClient; mount: (ui: ReactElement) => ReturnType<typeof render> } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    mount: (ui) => render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  };
}

afterEach(() => {
  mockedGet.mockReset();
  mockedPatch.mockReset();
  blocker.mockReset();
  navigate.mockReset();
});

const PROBLEM = {
  id: 1,
  code: 'aplusb',
  name: 'A Plus B',
  visibility: 'public' as const,
  hasPublishedRevision: true,
  timeMs: 1000,
  memoryKb: 65536,
  statement: 'Cong hai so.',
  sourceAccess: 'private' as const,
  testCount: 3,
  totalPoints: 100,
  checkerKind: 'wcmp',
  createdAt: '2026-01-01T00:00:00Z',
  members: [{ username: 'owner', role: 'author' as const }],
  orgSlugs: [],
  editorial: null,
  editorialAvailable: false,
  tags: [],
  difficulty: null,
};

const CONTEST = {
  key: 'tinh-2026',
  name: 'Ky thi tinh 2026',
  startTime: '2026-05-01T01:00:00.000Z',
  endTime: '2026-05-01T06:00:00.000Z',
  format: 'icpc',
  visibility: 'public' as const,
  participationMode: 'individual' as const,
  maxTeamSize: 3,
  frozenLastMinutes: 30,
  orgs: [],
  canEdit: true,
  problems: [
    { code: 'aplusb', points: 100, partial: false, label: 'A' },
    { code: 'xau', points: 100, partial: false, label: 'B' },
  ],
};

describe('the problem edit form, reopened after its own save', () => {
  it('shows the statement it just saved, not the one it replaced', async () => {
    const user = userEvent.setup();
    // The server's state, moved by the PATCH exactly as the real one is.
    const server = { ...PROBLEM };
    mockedGet.mockImplementation((path: string) => {
      if (path === '/problems/{code}') return Promise.resolve({ data: { ...server } });
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'setter', globalRole: 'setter' } });
      if (path === '/tags') return Promise.resolve({ data: { items: [] } });
      if (path === '/orgs') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });
    // The whole body lands, as `PATCH /problems/{code}` is a replace.
    mockedPatch.mockImplementation((_path: string, init: { body: Record<string, unknown> }) => {
      Object.assign(server, init.body);
      return Promise.resolve({ data: { ...server } });
    });

    const { mount } = walk();

    // Mount one: the setter rewrites the statement and saves.
    const first = mount(<ProblemEditPage code="aplusb" />);
    const box = await screen.findByLabelText('Đề bài');
    await waitFor(() => expect(box).toHaveValue('Cong hai so.'));
    await user.clear(box);
    await user.type(box, 'Cong hai so nguyen.');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(server.statement).toBe('Cong hai so nguyen.'));
    first.unmount();

    // Mount two: they come back — the browser Back button, or the nav — and
    // the cache still holds the entry the save never invalidated.
    mount(<ProblemEditPage code="aplusb" />);
    const reopened = await screen.findByLabelText('Đề bài');
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(reopened).toHaveValue('Cong hai so nguyen.');
  });

  it('does not write the pre-save statement back over the saved one', async () => {
    const user = userEvent.setup();
    const server = { ...PROBLEM };
    mockedGet.mockImplementation((path: string) => {
      if (path === '/problems/{code}') return Promise.resolve({ data: { ...server } });
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'setter', globalRole: 'setter' } });
      if (path === '/tags') return Promise.resolve({ data: { items: [] } });
      if (path === '/orgs') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });
    // The whole body lands, as `PATCH /problems/{code}` is a replace.
    mockedPatch.mockImplementation((_path: string, init: { body: Record<string, unknown> }) => {
      Object.assign(server, init.body);
      return Promise.resolve({ data: { ...server } });
    });

    const { mount } = walk();
    const first = mount(<ProblemEditPage code="aplusb" />);
    const box = await screen.findByLabelText('Đề bài');
    await waitFor(() => expect(box).toHaveValue('Cong hai so.'));
    await user.clear(box);
    await user.type(box, 'Cong hai so nguyen.');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(server.statement).toBe('Cong hai so nguyen.'));
    first.unmount();

    // Back on the form, they fix the NAME and save again. Nothing they do
    // touches the statement — so nothing they do should change it.
    mount(<ProblemEditPage code="aplusb" />);
    const name = await screen.findByLabelText('Tên');
    await waitFor(() => expect(name).toHaveValue('A Plus B'));
    await user.clear(name);
    await user.type(name, 'A + B');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(server.name).toBe('A + B'));
    expect(server.statement).toBe('Cong hai so nguyen.');
  });
});

describe('the contest edit form, reopened after its own save', () => {
  it('shows the problem list it just saved, not the one it replaced', async () => {
    const user = userEvent.setup();
    const server = { ...CONTEST, problems: [...CONTEST.problems] };
    mockedGet.mockImplementation((path: string) => {
      if (path === '/contests/{key}') {
        return Promise.resolve({ data: { ...server, problems: [...server.problems] } });
      }
      if (path === '/orgs') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });
    mockedPatch.mockImplementation(
      (_path: string, init: { body: { problems: typeof CONTEST.problems } }) => {
        server.problems = init.body.problems.map((row, index) => ({
          ...row,
          label: row.label ?? String(index),
        }));
        return Promise.resolve({ data: {} });
      },
    );

    const { mount } = walk();

    // Mount one: the organiser removes problem B — clearing its code is how
    // this form drops a row — and saves.
    const first = mount(<ContestEditPage contestKey="tinh-2026" />);
    await screen.findByLabelText('Mã bài 1');
    expect(screen.getByLabelText('Mã bài 2')).toHaveValue('xau');
    await user.clear(screen.getByLabelText('Mã bài 2'));
    await user.click(screen.getByRole('button', { name: 'Lưu kỳ thi' }));
    await waitFor(() => expect(server.problems).toHaveLength(1));
    first.unmount();

    // Mount two: they come back to fix the freeze, and the row they deleted
    // must not be sitting there again.
    mount(<ContestEditPage contestKey="tinh-2026" />);
    await screen.findByLabelText('Mã bài 1');
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(screen.queryByLabelText('Mã bài 2')).toBeNull();
  });
});

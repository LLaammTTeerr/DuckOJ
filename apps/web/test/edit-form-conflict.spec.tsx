/**
 * D161 — two people, one record, and the form that must not lose either one.
 *
 * B-31 closed the case where the stale copy a form was holding was the
 * setter's OWN, left behind by their own uninvalidated save. It recorded, and
 * could not fix without a ruling, the case with two people in it: teacher A
 * opens the form, teacher B saves, A fixes only the title — and A's whole-object
 * PATCH carries B's replaced statement straight back over the top of it.
 *
 * D161's answer has two halves and this file drives both:
 *
 *  - **clause A**, the form's: an already-seeded form takes a newer copy when
 *    the record moved AND nothing has been typed into it. A DIRTY form never
 *    reseeds, because that would be the same loss with the victims swapped;
 *  - **clause B**, the API's: a save carries the version it was seeded with,
 *    a stale one is refused 409, and the refusal is rendered as a form failure
 *    with an explicit offer to take the newer version — a button, never an
 *    automatic reload, because a conflict is by definition a form holding work.
 *
 * **One `QueryClient` across the whole walk**, `edit-form-stale-seed.spec.tsx`'s
 * shape and for its reason: every other spec for these pages builds a fresh
 * client per render, so it has a cold cache and none of this is visible. The
 * refetch is driven with `invalidateQueries`, which is what a window refocus,
 * a poll, or any sibling mutation does in a real browser.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const RELOAD = 'Tải bản mới nhất';
const RESEEDED = /Bản ghi này vừa được người khác sửa/;
const PROBLEM_CONFLICT = /Một người khác đã lưu bài tập này/;
const CONTEST_CONFLICT = /Một người khác đã lưu kỳ thi này/;

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
  version: 'v1',
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
  version: 'v1',
};

/** Everything the problem form reads, with one mutable server object behind it. */
function serveProblem(server: Record<string, unknown>): void {
  mockedGet.mockImplementation((path: string) => {
    if (path === '/problems/{code}') return Promise.resolve({ data: { ...server } });
    if (path === '/auth/me')
      return Promise.resolve({ data: { username: 'setter', globalRole: 'setter' } });
    if (path === '/tags') return Promise.resolve({ data: { items: [] } });
    if (path === '/orgs') return Promise.resolve({ data: { items: [] } });
    return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
  });
}

describe('the problem edit form while somebody else is saving (D161)', () => {
  it('takes the newer statement when nothing has been typed, and says that it did', async () => {
    const server: Record<string, unknown> = { ...PROBLEM };
    serveProblem(server);
    const { client, mount } = walk();

    mount(<ProblemEditPage code="aplusb" />);
    const box = await screen.findByLabelText('Đề bài');
    await waitFor(() => expect(box).toHaveValue('Cong hai so.'));

    // Teacher B saves, somewhere else entirely. The version moves with the
    // text, because the token is a hash of exactly what a PATCH can write.
    server.statement = 'Cong hai so nguyen, in ra tong.';
    server.version = 'v2';
    await client.invalidateQueries({ queryKey: ['problem', 'aplusb'] });

    // Clause A. Before it, `seededFrom === code` closed the guard forever and
    // this box kept the pre-save text until the page was remounted — and the
    // next save wrote it back.
    await waitFor(() => expect(box).toHaveValue('Cong hai so nguyen, in ra tong.'));
    // Announced, never silent: nothing was lost, and saying so is what stops a
    // setter who looked away from concluding the site ate their draft.
    expect(screen.getByText(RESEEDED)).toBeTruthy();
  });

  // The one case here that is NOT a bug demonstration: it passes against the
  // pre-D161 code too, because that code never reseeded at all. It is a
  // regression guard on the dangerous half of clause A — the half that would
  // turn this feature back into data loss if somebody later "simplified" the
  // condition to "reseed whenever the version moved".
  it('keeps what the setter has typed when the record moves under a DIRTY form', async () => {
    const user = userEvent.setup();
    const server: Record<string, unknown> = { ...PROBLEM };
    serveProblem(server);
    const { client, mount } = walk();

    mount(<ProblemEditPage code="aplusb" />);
    const box = await screen.findByLabelText('Đề bài');
    await waitFor(() => expect(box).toHaveValue('Cong hai so.'));
    await user.clear(box);
    await user.type(box, 'Ban nhap cua toi.');

    server.statement = 'Cong hai so nguyen, in ra tong.';
    server.version = 'v2';
    await client.invalidateQueries({ queryKey: ['problem', 'aplusb'] });

    // The half of clause A that carries the ruling. Reseeding here would be
    // the SAME data loss with the victims swapped — this teacher's work
    // instead of the other one's — so a dirty form keeps its typing, keeps its
    // stale token, and is refused by the API on save instead.
    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(4));
    expect(box).toHaveValue('Ban nhap cua toi.');
    expect(screen.queryByText(RESEEDED)).toBeNull();
  });

  it('sends the version it was seeded with, and offers the newer one when the save is refused', async () => {
    const user = userEvent.setup();
    const server: Record<string, unknown> = { ...PROBLEM };
    serveProblem(server);
    // The server has moved on since this form was seeded, so it refuses.
    mockedPatch.mockImplementation(() =>
      Promise.resolve({ data: undefined, error: { code: 'problem_version_conflict' } }),
    );
    const { mount } = walk();

    mount(<ProblemEditPage code="aplusb" />);
    const name = await screen.findByLabelText('Tên');
    await waitFor(() => expect(name).toHaveValue('A Plus B'));
    // The typo fix that used to destroy a colleague's rewrite.
    await user.clear(name);
    await user.type(name, 'A + B');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));

    // Clause B's client half: the token goes out with the body.
    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    const body = (mockedPatch.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body.expectedVersion).toBe('v1');

    // The refusal, said in words, with the offer beside it — and the setter's
    // own typing still on screen, which is the whole reason the reload is a
    // button rather than something the page does for them.
    expect(await screen.findByText(PROBLEM_CONFLICT)).toBeTruthy();
    expect(screen.getByLabelText('Tên')).toHaveValue('A + B');
    const reload = screen.getByRole('button', { name: RELOAD });

    // Pressing it is the setter giving their copy up, deliberately.
    server.name = 'A cong B';
    server.statement = 'Cong hai so nguyen, in ra tong.';
    server.version = 'v2';
    await user.click(reload);
    await waitFor(() => expect(screen.getByLabelText('Tên')).toHaveValue('A cong B'));
    expect(screen.getByLabelText('Đề bài')).toHaveValue('Cong hai so nguyen, in ra tong.');
    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull();
  });
});

describe('the contest edit form while a co-organiser is saving (D161)', () => {
  it('refuses to send the stale problem list back, and keeps it on screen until the organiser chooses', async () => {
    const user = userEvent.setup();
    const server: Record<string, unknown> = { ...CONTEST, problems: [...CONTEST.problems] };
    mockedGet.mockImplementation((path: string) => {
      if (path === '/contests/{key}') {
        return Promise.resolve({
          data: { ...server, problems: [...(server.problems as unknown[])] },
        });
      }
      if (path === '/orgs') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });
    mockedPatch.mockImplementation(() =>
      Promise.resolve({ data: undefined, error: { code: 'contest_version_conflict' } }),
    );
    const { mount } = walk();

    mount(<ContestEditPage contestKey="tinh-2026" />);
    await screen.findByLabelText('Mã bài 1');
    // The organiser drops problem B — clearing its code is how this form drops
    // a row — and saves. Behind their back a co-organiser has already changed
    // the round, so `problems` in this body is the all-or-nothing field that
    // would have taken THEIR change out with it.
    await user.clear(screen.getByLabelText('Mã bài 2'));
    await user.click(screen.getByRole('button', { name: 'Lưu kỳ thi' }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    const body = (mockedPatch.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body.expectedVersion).toBe('v1');

    expect(await screen.findByText(CONTEST_CONFLICT)).toBeTruthy();
    // Nothing navigated, and nothing the organiser did was thrown away: the
    // row they deleted is still deleted on screen, waiting for them to decide.
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Mã bài 1')).toHaveValue('aplusb');
    expect(screen.getByRole('button', { name: RELOAD })).toBeTruthy();
  });
});

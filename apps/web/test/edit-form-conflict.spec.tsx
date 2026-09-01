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
const mockedPut = vi.fn();
const { blocker, navigate } = vi.hoisted(() => ({ blocker: vi.fn(), navigate: vi.fn() }));
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => mockedGet(...a),
    POST: vi.fn(),
    // `PUT` is the language-limits tab's verb — the only form in this app that
    // sends one (D159).
    PUT: (...a: unknown[]) => mockedPut(...a),
    DELETE: vi.fn(),
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
const { ProblemLanguageLimitsTab } = await import('../src/routes/problem-language-limits.js');
const { ProblemSetPage } = await import('../src/routes/problem-sets.js');
const { OrgTeams } = await import('../src/routes/teams.js');

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
  mockedPut.mockReset();
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

/**
 * D176 — the same two clauses, on the three other forms that have the shape.
 *
 * Each walk is the one the ruling is about: the form is seeded, somebody else
 * saves, and the field at risk is a whole LIST the person at this keyboard
 * never typed — every language's row, the set's problem list, the team's
 * roster. That is what makes these different from a text box: the loss is
 * invisible on screen, because the form is showing exactly what it was given.
 *
 * One `QueryClient` across each walk, real keys, and `invalidateQueries` for
 * the refetch — `edit-form-stale-seed.spec.tsx`'s shape, and the only shape in
 * which this class of defect is visible at all.
 */

const LANG_CONFLICT = /Một người khác đã lưu giới hạn ngôn ngữ/;
/**
 * The C++ multiplier box, by its own `aria-label` rather than by the language
 * name: the name appears on the row header AND on all three of that row's
 * labels, so a regex over it matches five elements and finds nothing.
 */
const TIME_CPP = 'Tỉ lệ thời gian cho C++17, tính theo phần trăm';
const SET_CONFLICT = /Một người khác đã lưu bộ bài tập này/;
const TEAM_CONFLICT = /Một người khác đã lưu đội này/;

const LANGUAGE_SETTINGS = {
  base: { timeMs: 1000, memoryKb: 256_000 },
  languages: [
    {
      languageKey: 'cpp17',
      languageName: 'C++17',
      defaultTimeMultiplierPct: 100,
      defaultMemoryExtraKb: 0,
      timeMultiplierPct: null,
      memoryExtraKb: null,
      allowed: true,
    },
    {
      languageKey: 'python3',
      languageName: 'Python 3',
      defaultTimeMultiplierPct: 300,
      defaultMemoryExtraKb: 32_768,
      timeMultiplierPct: null,
      memoryExtraKb: null,
      allowed: true,
    },
  ],
  version: 'v1',
};

describe("the language-limits tab while a co-setter is saving (D176)", () => {
  it('takes the newer overrides when nothing has been typed, and says that it did', async () => {
    const server: Record<string, unknown> = {
      ...LANGUAGE_SETTINGS,
      languages: LANGUAGE_SETTINGS.languages.map((lang) => ({ ...lang })),
    };
    mockedGet.mockImplementation((path: string) => {
      if (path === '/problems/{code}/language-limits') {
        return Promise.resolve({
          data: { ...server, languages: (server.languages as unknown[]).map((l) => ({ ...(l as object) })) },
        });
      }
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });
    const { client, mount } = walk();

    mount(<ProblemLanguageLimitsTab code="aplusb" />);
    const cpp = await screen.findByLabelText(TIME_CPP);
    await waitFor(() => expect(cpp).toHaveValue(null));

    // The co-setter refuses Python and raises C++'s multiplier. Before clause
    // A this tab kept showing the pre-save numbers, and the next save PUT them
    // back over the top.
    server.languages = [
      { ...LANGUAGE_SETTINGS.languages[0]!, timeMultiplierPct: 150 },
      { ...LANGUAGE_SETTINGS.languages[1]!, allowed: false },
    ];
    server.version = 'v2';
    await client.invalidateQueries({ queryKey: ['problem-language-limits', 'aplusb'] });

    await waitFor(() => expect(screen.getByLabelText(TIME_CPP)).toHaveValue(150));
    expect(screen.getByText(RESEEDED)).toBeTruthy();
  });

  it('sends the version it was seeded with, and offers the newer one when the save is refused', async () => {
    const user = userEvent.setup();
    const server: Record<string, unknown> = {
      ...LANGUAGE_SETTINGS,
      languages: LANGUAGE_SETTINGS.languages.map((lang) => ({ ...lang })),
    };
    mockedGet.mockImplementation((path: string) => {
      if (path === '/problems/{code}/language-limits') {
        return Promise.resolve({
          data: { ...server, languages: (server.languages as unknown[]).map((l) => ({ ...(l as object) })) },
        });
      }
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });
    mockedPut.mockImplementation(() =>
      Promise.resolve({ data: undefined, error: { code: 'language_limits_version_conflict' } }),
    );
    const { mount } = walk();

    mount(<ProblemLanguageLimitsTab code="aplusb" />);
    const cpp = await screen.findByLabelText(TIME_CPP);
    await waitFor(() => expect(cpp).toBeTruthy());
    // The setter raises C++'s multiplier. Their tab still holds `allowed: true`
    // for Python — the co-setter's refusal, about to be PUT away.
    await user.type(cpp, '150');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(mockedPut).toHaveBeenCalled());
    const body = (mockedPut.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body.expectedVersion).toBe('v1');

    expect(await screen.findByText(LANG_CONFLICT)).toBeTruthy();
    // The setter's own typing is still on screen: the reload is a button, and
    // until they press it nothing has been taken from them.
    expect(screen.getByLabelText(TIME_CPP)).toHaveValue(150);
    const reload = screen.getByRole('button', { name: RELOAD });

    server.languages = [
      { ...LANGUAGE_SETTINGS.languages[0]!, timeMultiplierPct: 200 },
      { ...LANGUAGE_SETTINGS.languages[1]!, allowed: false },
    ];
    server.version = 'v2';
    await user.click(reload);
    await waitFor(() => expect(screen.getByLabelText(TIME_CPP)).toHaveValue(200));
    expect(screen.queryByRole('button', { name: RELOAD })).toBeNull();
  });
});

const SET_DETAIL = {
  slug: 'tuan-1',
  name: 'Tuần 1',
  description: null,
  deadline: null,
  itemCount: 1,
  solvedCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  items: [
    { code: 'aplusb', name: 'A Plus B', order: 0, points: 100, visible: true, me: null },
    { code: 'xau', name: 'Xau', order: 1, points: 100, visible: true, me: null },
  ],
  version: 'v1',
};

describe('the problem-set form while a co-teacher is saving (D176)', () => {
  it('refuses to send the stale problem list back, and keeps it on screen until the teacher chooses', async () => {
    const user = userEvent.setup();
    mockedGet.mockImplementation((path: string) => {
      if (path === '/auth/me')
        return Promise.resolve({ data: { username: 'teacher', globalRole: 'user' } });
      if (path === '/orgs/{slug}') return Promise.resolve({ data: { slug: 'thpt', name: 'THPT', myRole: 'owner' } });
      if (path === '/orgs/{slug}/sets/{setSlug}') {
        return Promise.resolve({ data: { ...SET_DETAIL, items: SET_DETAIL.items.map((i) => ({ ...i })) } });
      }
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });
    mockedPatch.mockImplementation(() =>
      Promise.resolve({ data: undefined, error: { code: 'problem_set_version_conflict' } }),
    );
    const { mount } = walk();

    mount(<ProblemSetPage slug="thpt" setSlug="tuan-1" />);
    await user.click(await screen.findByRole('button', { name: 'Sửa bài tập' }));

    // The teacher drops the second problem and saves. `problems` REPLACES the
    // whole list, so this body would also take out whatever the co-teacher
    // added while the form was open.
    const remove = await screen.findAllByRole('button', { name: 'Bỏ' });
    await user.click(remove[1]!);
    await user.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    const body = (mockedPatch.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body.expectedVersion).toBe('v1');
    expect(body.problems).toEqual([{ code: 'aplusb', points: 100 }]);

    expect(await screen.findByText(SET_CONFLICT)).toBeTruthy();
    // Nothing the teacher did was thrown away: the row they removed is still
    // removed on screen, waiting for them to decide.
    expect(screen.getByRole('button', { name: RELOAD })).toBeTruthy();
  });
});

const TEAM_DETAIL = {
  slug: 'doi-1',
  name: 'Đội 1',
  orgSlug: 'thpt',
  orgName: 'THPT',
  memberCount: 2,
  createdAt: '2026-01-01T00:00:00Z',
  inRunningContest: false,
  members: [
    { username: 'an', displayName: 'An', joinedAt: '2026-01-01T00:00:00Z' },
    { username: 'binh', displayName: 'Bình', joinedAt: '2026-01-01T00:00:00Z' },
  ],
  contests: [],
  canEdit: true,
  version: 'v1',
};

describe('the team form while a co-admin is saving (D176)', () => {
  it('refuses to send the stale roster back, and keeps what was typed on screen', async () => {
    const user = userEvent.setup();
    mockedGet.mockImplementation((path: string) => {
      if (path === '/auth/me')
        return Promise.resolve({ data: { username: 'teacher', globalRole: 'user' } });
      if (path === '/orgs/{slug}/teams') {
        return Promise.resolve({
          data: {
            items: [
              {
                slug: 'doi-1',
                name: 'Đội 1',
                orgSlug: 'thpt',
                orgName: 'THPT',
                memberCount: 2,
                // Carried on the summary since D182.
                members: [
                  { username: 'an', displayName: 'An', joinedAt: '2026-01-01T00:00:00Z' },
                  { username: 'binh', displayName: 'Bình', joinedAt: '2026-01-01T00:00:00Z' },
                ],
                createdAt: '2026-01-01T00:00:00Z',
                inRunningContest: false,
              },
            ],
          },
        });
      }
      if (path === '/orgs/{slug}/teams/{teamSlug}') {
        return Promise.resolve({ data: { ...TEAM_DETAIL, members: TEAM_DETAIL.members.map((m) => ({ ...m })) } });
      }
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });
    mockedPatch.mockImplementation(() =>
      Promise.resolve({ data: undefined, error: { code: 'team_version_conflict' } }),
    );
    const { mount } = walk();

    mount(<OrgTeams slug="thpt" canManage />);
    await user.click(await screen.findByRole('button', { name: 'Sửa' }));

    // The admin fixes the team's NAME only. `members` still carries the roster
    // of two this form was seeded with — and a co-admin has since added a
    // third pupil, who this save would drop. On contest morning that is a
    // pupil who cannot compete.
    const name = await screen.findByLabelText('Tên đội');
    await user.clear(name);
    await user.type(name, 'Đội Một');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    const body = (mockedPatch.mock.calls[0]![1] as { body: Record<string, unknown> }).body;
    expect(body.expectedVersion).toBe('v1');
    expect(body.members).toEqual(['an', 'binh']);

    expect(await screen.findByText(TEAM_CONFLICT)).toBeTruthy();
    expect(screen.getByLabelText('Tên đội')).toHaveValue('Đội Một');
    expect(screen.getByRole('button', { name: RELOAD })).toBeTruthy();
  });
});

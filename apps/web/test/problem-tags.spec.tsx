import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { ProblemsPage, parseDifficulty } from '../src/routes/problems.js';
import { ProblemPage } from '../src/routes/problem.js';
import { ProblemEditPage } from '../src/routes/problem-edit.js';
import { LocaleProvider } from '../src/i18n/index.js';

vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn() },
}));

const mockedGet = vi.mocked(api.GET);
const mockedPatch = vi.mocked(api.PATCH);

afterEach(() => {
  mockedGet.mockReset();
  mockedPatch.mockReset();
});

const GRAPHS = { slug: 'do-thi', nameVi: 'Đồ thị', nameEn: 'Graphs' };
const DP = { slug: 'quy-hoach-dong', nameVi: 'Quy hoạch động', nameEn: 'Dynamic programming' };

function apiResponse(data: unknown) {
  return { data, error: undefined, response: new Response() };
}

function mockApiGet(handlers: Record<string, unknown>): void {
  mockedGet.mockImplementation((async (path: string) => {
    if (path === '/auth/me' && !(path in handlers)) return apiResponse(undefined);
    if (path === '/tags' && !(path in handlers)) return apiResponse({ items: [] });
    if (!(path in handlers)) throw new Error(`unmocked GET ${path}`);
    return handlers[path];
  }) as never);
}

const PROBLEM = {
  id: 1,
  code: 'aplusb',
  name: 'A Plus B',
  visibility: 'public' as const,
  hasPublishedRevision: true,
  timeMs: 1000,
  memoryKb: 65536,
  testCount: 3,
  me: null,
  tags: [GRAPHS],
  difficulty: 4,
};

const DETAIL = {
  ...PROBLEM,
  statement: 'Add.',
  sourceAccess: 'private' as const,
  totalPoints: 100,
  checkerKind: 'wcmp',
  createdAt: '2026-01-01T00:00:00Z',
  members: [],
  orgSlugs: [],
  editorial: null,
  editorialAvailable: false,
};

const testRootRoute = createRootRoute();
const testProblemsRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/problems' });
const testProblemRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/problems/$code' });
const testSubmitRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/submit' });
const testSubmissionsRoute = createRoute({ getParentRoute: () => testRootRoute, path: '/submissions' });
const testRouter = createRouter({
  routeTree: testRootRoute.addChildren([
    testProblemsRoute,
    testProblemRoute,
    testSubmitRoute,
    testSubmissionsRoute,
  ]),
  history: createMemoryHistory({ initialEntries: ['/problems'] }),
});

function renderWithClient(ui: ReactElement, locale?: 'vi' | 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <RouterContextProvider router={testRouter}>{ui}</RouterContextProvider>
    </QueryClientProvider>
  );
  return render(locale === undefined ? tree : <LocaleProvider>{tree}</LocaleProvider>);
}

describe('parseDifficulty', () => {
  it('accepts 1..10 and treats everything else as no bound', () => {
    expect(parseDifficulty('1')).toBe(1);
    expect(parseDifficulty('10')).toBe(10);
    expect(parseDifficulty('')).toBeUndefined();
    expect(parseDifficulty('  ')).toBeUndefined();
    expect(parseDifficulty('0')).toBeUndefined();
    expect(parseDifficulty('11')).toBeUndefined();
    expect(parseDifficulty('3.5')).toBeUndefined();
    expect(parseDifficulty('abc')).toBeUndefined();
  });
});

describe('the problem list', () => {
  it('renders a difficulty column and a linked chip per tag, in the active locale', async () => {
    mockApiGet({ '/problems': apiResponse({ items: [PROBLEM], nextCursor: null }) });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    const row = screen.getAllByRole('row')[1]!;
    // Vietnamese is the default locale (D18), so the chip carries `nameVi`.
    const chip = within(row).getByRole('link', { name: 'Đồ thị' });
    // TanStack Router owns serializing `search` (it JSON-encodes an array),
    // so this asserts on the decoded href rather than pinning the exact
    // encoding — what matters is that the chip links at the filtered list.
    expect(decodeURIComponent(chip.getAttribute('href') ?? '')).toContain('/problems?tag=["do-thi"]');
    // Difficulty is cell 6 since D49 added the solved/attempted column
    // between Tests and it (code, name, time, mem, tests, solved, difficulty).
    expect(within(row).getAllByRole('cell')[6]).toHaveTextContent('4');
  });

  it('renders no chips at all for a problem whose tags are empty', async () => {
    mockApiGet({
      '/problems': apiResponse({ items: [{ ...PROBLEM, tags: [], difficulty: null }], nextCursor: null }),
    });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    // Exactly what a viewer sitting a running contest sees (D35): the API
    // blanks tags to `[]`, indistinguishable from an untagged problem, and
    // this page must not invent a "hidden" marker that gives the game away.
    const row = screen.getAllByRole('row')[1]!;
    expect(within(row).queryByRole('link', { name: 'Đồ thị' })).toBeNull();
  });

  it('sends the checked topics as repeated ?tag=, ANDing them', async () => {
    mockApiGet({
      '/problems': apiResponse({ items: [PROBLEM], nextCursor: null }),
      '/tags': apiResponse({ items: [GRAPHS, DP] }),
    });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    await userEvent.click(await screen.findByLabelText('Đồ thị'));
    await waitFor(() => {
      const last = mockedGet.mock.calls.filter((c) => c[0] === '/problems').at(-1);
      expect(last?.[1]).toMatchObject({ params: { query: { tag: ['do-thi'] } } });
    });

    await userEvent.click(screen.getByLabelText('Quy hoạch động'));
    await waitFor(() => {
      const last = mockedGet.mock.calls.filter((c) => c[0] === '/problems').at(-1);
      expect(last?.[1]).toMatchObject({ params: { query: { tag: ['do-thi', 'quy-hoach-dong'] } } });
    });

    // Unchecking removes just that one, rather than clearing the set.
    await userEvent.click(screen.getByLabelText('Đồ thị'));
    await waitFor(() => {
      const last = mockedGet.mock.calls.filter((c) => c[0] === '/problems').at(-1);
      expect(last?.[1]).toMatchObject({ params: { query: { tag: ['quy-hoach-dong'] } } });
    });
  });

  it('sends a difficulty range, and clears every filter on the clear button', async () => {
    mockApiGet({
      '/problems': apiResponse({ items: [PROBLEM], nextCursor: null }),
      '/tags': apiResponse({ items: [GRAPHS] }),
    });

    renderWithClient(<ProblemsPage />);
    await screen.findByText('aplusb');

    await userEvent.type(screen.getByLabelText('Từ'), '3');
    await userEvent.type(screen.getByLabelText('Đến'), '7');
    await userEvent.click(await screen.findByLabelText('Đồ thị'));
    await waitFor(() => {
      const last = mockedGet.mock.calls.filter((c) => c[0] === '/problems').at(-1);
      expect(last?.[1]).toMatchObject({
        params: { query: { difficultyMin: 3, difficultyMax: 7, tag: ['do-thi'] } },
      });
    });

    await userEvent.click(screen.getByRole('button', { name: 'Xoá bộ lọc' }));
    await waitFor(() => {
      const last = mockedGet.mock.calls.filter((c) => c[0] === '/problems').at(-1);
      expect(last?.[1]).toEqual({ params: { query: {} } });
    });
  });

  it('reports a filter change to its route so the URL can follow', async () => {
    mockApiGet({
      '/problems': apiResponse({ items: [PROBLEM], nextCursor: null }),
      '/tags': apiResponse({ items: [GRAPHS] }),
    });
    const onFiltersChange = vi.fn();

    renderWithClient(<ProblemsPage onFiltersChange={onFiltersChange} />);
    await screen.findByText('aplusb');
    await userEvent.click(await screen.findByLabelText('Đồ thị'));

    expect(onFiltersChange).toHaveBeenCalledWith({ tags: ['do-thi'] });
  });

  it('opens with the filters its route seeded it from', async () => {
    mockApiGet({
      '/problems': apiResponse({ items: [PROBLEM], nextCursor: null }),
      '/tags': apiResponse({ items: [GRAPHS] }),
    });

    renderWithClient(<ProblemsPage initialFilters={{ tags: ['do-thi'], difficultyMin: 2 }} />);
    await screen.findByText('aplusb');

    // The first request already carries them — a deep link must not render
    // the whole list and then narrow it.
    const first = mockedGet.mock.calls.filter((c) => c[0] === '/problems')[0];
    expect(first?.[1]).toMatchObject({ params: { query: { tag: ['do-thi'], difficultyMin: 2 } } });
    expect((await screen.findByLabelText('Đồ thị')) as HTMLInputElement).toBeChecked();
  });
});

describe('the problem page', () => {
  it('shows the difficulty and a linked chip per tag', async () => {
    mockApiGet({ '/problems/{code}': apiResponse(DETAIL) });

    renderWithClient(<ProblemPage code="aplusb" />);

    const chip = await screen.findByRole('link', { name: 'Đồ thị' });
    expect(decodeURIComponent(chip.getAttribute('href') ?? '')).toContain('/problems?tag=["do-thi"]');
    expect(screen.getByText(/Độ khó: 4\/10/)).toBeInTheDocument();
    // The chips are labelled the way the number beside them is. `Chủ đề`
    // was a translated catalogue key no screen asked for, and a row of bare
    // links beside "Độ khó: 4/10" reads as a second, unnamed quantity.
    expect(screen.getByText(/Chủ đề:/)).toBeInTheDocument();
  });

  it('shows neither when the problem carries neither', async () => {
    mockApiGet({ '/problems/{code}': apiResponse({ ...DETAIL, tags: [], difficulty: null }) });

    renderWithClient(<ProblemPage code="aplusb" />);

    await screen.findByRole('link', { name: 'PDF' });
    expect(screen.queryByText(/Độ khó/)).toBeNull();
    expect(screen.queryByText(/Chủ đề:/)).toBeNull();
  });
});

describe('the edit form', () => {
  it('prefills the tag checkboxes and the difficulty, and PATCHes both back', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse(DETAIL),
      '/tags': apiResponse({ items: [GRAPHS, DP] }),
    });
    mockedPatch.mockResolvedValue({ data: DETAIL, error: undefined, response: new Response() } as never);

    renderWithClient(<ProblemEditPage code="aplusb" />);

    const graphs = (await screen.findByLabelText('Đồ thị')) as HTMLInputElement;
    expect(graphs).toBeChecked();
    expect(screen.getByLabelText(/Độ khó/)).toHaveValue(4);

    await userEvent.click(screen.getByLabelText('Quy hoạch động'));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith(
        '/problems/{code}',
        expect.objectContaining({
          body: expect.objectContaining({ tags: ['do-thi', 'quy-hoach-dong'], difficulty: 4 }),
        }),
      );
    });
  });

  it('sends an explicit null when the difficulty box is emptied', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse(DETAIL),
      '/tags': apiResponse({ items: [GRAPHS] }),
    });
    mockedPatch.mockResolvedValue({ data: DETAIL, error: undefined, response: new Response() } as never);

    renderWithClient(<ProblemEditPage code="aplusb" />);

    await userEvent.clear(await screen.findByLabelText(/Độ khó/));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));

    // `null` clears it; an omitted key would mean "leave it", and a form
    // whose blank box left the old value would make un-rating impossible.
    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith(
        '/problems/{code}',
        expect.objectContaining({ body: expect.objectContaining({ difficulty: null }) }),
      );
    });
  });

  it('offers no tag picker on the create route', async () => {
    mockApiGet({ '/tags': apiResponse({ items: [GRAPHS] }) });

    renderWithClient(<ProblemEditPage />);

    // A problem is created untagged and classified deliberately afterwards
    // — `CreateProblemRequest` carries neither field.
    await screen.findByLabelText(/^Mã$/);
    expect(screen.queryByLabelText('Đồ thị')).toBeNull();
    expect(screen.queryByLabelText(/Độ khó/)).toBeNull();
  });
});

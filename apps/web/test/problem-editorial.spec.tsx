import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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

const EDITORIAL = '## Lời giải\n\nCộng hai số với $a + b$.';

const DETAIL = {
  id: 1,
  code: 'aplusb',
  name: 'A Plus B',
  visibility: 'public' as const,
  hasPublishedRevision: true,
  timeMs: 1000,
  memoryKb: 65536,
  testCount: 3,
  me: null,
  tags: [],
  difficulty: null,
  statement: 'Add.',
  sourceAccess: 'private' as const,
  totalPoints: 100,
  checkerKind: 'wcmp',
  createdAt: '2026-01-01T00:00:00Z',
  members: [],
  orgSlugs: [],
  editorial: null as string | null,
  editorialAvailable: false,
};

/**
 * Both components render `<Link>`s, so both need a router in scope. Nothing
 * here navigates — the memory router exists only so the links resolve.
 */
function renderRouted(ui: ReactElement) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => ui });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <RouterContextProvider router={router}>{ui}</RouterContextProvider>
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe('the editorial on a problem page', () => {
  it('renders nothing at all when the API withheld it', async () => {
    // The API answers `null`/`false` identically for "no editorial", "an
    // unpublished draft" and "withheld while you sit the contest" (D43), so
    // this page has exactly one thing to render for all three: nothing.
    mockApiGet({ '/problems/{code}': apiResponse(DETAIL) });
    renderRouted(<ProblemPage code="aplusb" />);

    await screen.findByRole('heading', { name: /A Plus B/ });
    expect(document.querySelector('details')).toBeNull();
  });

  it('renders it behind a disclosure, as sanitized Markdown, when it is available', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse({ ...DETAIL, editorial: EDITORIAL, editorialAvailable: true }),
    });
    renderRouted(<ProblemPage code="aplusb" />);

    // Behind a `<details>`: nobody should meet a spoiler by scrolling.
    const summary = await waitFor(() => {
      const found = document.querySelector('summary');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(summary.textContent).toBe('Lời giải');
    // Rendered through the same Markdown+KaTeX pipeline as the statement,
    // not printed as source. `renderStatement` demotes headings by two
    // levels (markdown.ts), so the editorial's `##` lands as an `h3` under
    // the page's own `h1`.
    expect(screen.getByRole('heading', { name: 'Lời giải', level: 3 })).toBeTruthy();
    expect(document.querySelector('.katex')).toBeTruthy();
  });

  it("marks an editor's unpublished draft as a draft", async () => {
    mockApiGet({
      '/problems/{code}': apiResponse({ ...DETAIL, editorial: EDITORIAL, editorialAvailable: false }),
    });
    renderRouted(<ProblemPage code="aplusb" />);

    // An editor is the only viewer the API hands a non-null editorial with
    // `editorialAvailable: false`, so the marker cannot leak to a reader.
    await screen.findByText(/bản nháp — chưa xuất bản/);
  });
});

describe('the editorial on the edit form', () => {
  it('seeds the textarea from the draft and the toggle from its publish state', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse({ ...DETAIL, editorial: EDITORIAL, editorialAvailable: false }),
    });
    renderRouted(<ProblemEditPage code="aplusb" />);

    const box = await screen.findByLabelText('Lời giải (Markdown, tiếng Việt và tiếng Anh)');
    await waitFor(() => {
      expect((box as HTMLTextAreaElement).value).toBe(EDITORIAL);
    });
    expect((screen.getByLabelText('Xuất bản lời giải') as HTMLInputElement).checked).toBe(false);
    // The preview is the same renderer the problem page uses, so what is
    // proofread here is what a reader gets.
    const preview = screen.getByTestId('editorial-preview');
    expect(preview.querySelector('h3')?.textContent).toBe('Lời giải');
  });

  it('checks the toggle for an already-published editorial', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse({ ...DETAIL, editorial: EDITORIAL, editorialAvailable: true }),
    });
    renderRouted(<ProblemEditPage code="aplusb" />);

    await waitFor(() => {
      expect((screen.getByLabelText('Xuất bản lời giải') as HTMLInputElement).checked).toBe(true);
    });
  });

  it('sends both keys on save, and an empty box as an explicit null', async () => {
    mockApiGet({
      '/problems/{code}': apiResponse({ ...DETAIL, editorial: EDITORIAL, editorialAvailable: false }),
    });
    mockedPatch.mockResolvedValue(apiResponse(DETAIL) as never);
    renderRouted(<ProblemEditPage code="aplusb" />);

    const box = await screen.findByLabelText('Lời giải (Markdown, tiếng Việt và tiếng Anh)');
    await waitFor(() => {
      expect((box as HTMLTextAreaElement).value).toBe(EDITORIAL);
    });
    await userEvent.click(screen.getByLabelText('Xuất bản lời giải'));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalled();
    });
    const body = mockedPatch.mock.calls[0]![1] as { body: Record<string, unknown> };
    expect(body.body.editorial).toBe(EDITORIAL);
    expect(body.body.editorialPublished).toBe(true);

    // Clearing the box is a request to remove the editorial, not to leave it
    // alone — `null`, never an omitted key.
    await userEvent.clear(box);
    await userEvent.click(screen.getByLabelText('Xuất bản lời giải'));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => {
      expect(mockedPatch.mock.calls.length).toBe(2);
    });
    const second = mockedPatch.mock.calls[1]![1] as { body: Record<string, unknown> };
    expect(second.body.editorial).toBeNull();
    expect(second.body.editorialPublished).toBe(false);
  });

  it('offers no editorial field at all on the create route', () => {
    mockApiGet({});
    renderRouted(<ProblemEditPage />);

    // `CreateProblemRequest` carries neither key — a problem is created
    // without an editorial and gets one afterwards, exactly like its tags.
    expect(screen.queryByLabelText('Lời giải (Markdown, tiếng Việt và tiếng Anh)')).toBeNull();
    expect(screen.queryByLabelText('Xuất bản lời giải')).toBeNull();
  });
});

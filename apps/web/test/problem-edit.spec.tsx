import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { ProblemEditPage } from '../src/routes/problem-edit.js';
import { ProblemRevisionsPage } from '../src/routes/problem-revisions.js';

// Same pattern problems.spec.tsx established: mock the whole SDK client, so
// every route file under test here reaches the network only through `api`.
// This spec also needs `PATCH`, which problems.spec.tsx's mock never
// declared (Task 11 never sent one).
vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn() },
}));

const mockedGet = vi.mocked(api.GET);
const mockedPost = vi.mocked(api.POST);
const mockedPatch = vi.mocked(api.PATCH);

function renderWithClient(ui: ReactElement) {
  // A fresh, no-retry client per render: without `retry: false` a mocked
  // 404 (or any rejected queryFn) retries several times with backoff before
  // settling into its error state — see problems.spec.tsx for the same
  // rationale.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  mockedGet.mockReset();
  mockedPost.mockReset();
  mockedPatch.mockReset();
});

const PROBLEM_DETAIL = {
  id: 1,
  code: 'aplusb',
  name: 'A Plus B',
  visibility: 'public' as const,
  hasPublishedRevision: true,
  timeMs: 1000,
  memoryKb: 65536,
  statement: 'Add two numbers.',
  sourceAccess: 'private' as const,
  testCount: 3,
  totalPoints: 100,
  checkerKind: 'wcmp',
  createdAt: '2026-01-01T00:00:00Z',
  members: [{ username: 'owner', role: 'author' as const }],
  orgSlugs: [],
  tags: [],
  difficulty: null,
};

describe('ProblemEditPage', () => {
  it('the code field is disabled on the edit route and enabled on the new route', async () => {
    mockedGet.mockResolvedValueOnce({
      data: PROBLEM_DETAIL,
      error: undefined,
      response: new Response(),
    } as never);

    // Two renders in one test — codes are immutable
    // (`problem_code_immutable`), so a form that let someone type into this
    // field on the edit route and have that value silently dropped on
    // submit would be worse than not offering the field at all; both states
    // must hold, not just one in isolation. `edit.unmount()` between them
    // avoids the two trees colliding on the same static `id`s, which
    // otherwise breaks `<label for>` association for both.
    const edit = renderWithClient(<ProblemEditPage code="aplusb" />);
    const editCodeInput = await screen.findByLabelText(/^Mã$/);
    expect(editCodeInput).toBeDisabled();
    edit.unmount();

    renderWithClient(<ProblemEditPage />);
    const createCodeInput = screen.getByLabelText(/^Mã$/);
    expect(createCodeInput).not.toBeDisabled();
  });

  it('the preview pane updates as the statement changes', async () => {
    renderWithClient(<ProblemEditPage />);

    // userEvent.type() parses `{...}` as its key-descriptor DSL — Markdown
    // headings don't collide with it, but paste is still closer to how a
    // setter actually gets a statement into this field (write it elsewhere,
    // paste it in), matching submit.spec.tsx's rationale for its own
    // textarea.
    await userEvent.click(screen.getByLabelText(/Đề bài/));
    await userEvent.paste('# Hello');

    const preview = screen.getByTestId('statement-preview');
    // `renderStatement` is the same sanitize-last pipeline problem.tsx
    // uses; asserting the actual rendered heading (not just "the pane is
    // non-empty") confirms the live preview is really running Markdown
    // through it on every keystroke, not just echoing raw text.
    await waitFor(() => {
      // <h2>, not <h1>: renderStatement demotes statement headings so a
      // statement cannot inject a second page-level heading.
      expect(preview.querySelector('h2')).toHaveTextContent('Hello');
    });
  });

  // design 2026-08-21-submission-source-visibility-design.md §2.3/§5: the
  // API has carried `sourceAccess` since that design landed but the
  // authoring screen never rendered it — this is that screen catching up.
  it('prefills the source-access select from GET, and PATCH carries a change to it', async () => {
    mockedGet.mockResolvedValueOnce({
      data: { ...PROBLEM_DETAIL, sourceAccess: 'solved' as const },
      error: undefined,
      response: new Response(),
    } as never);
    mockedPatch.mockResolvedValueOnce({
      data: { ...PROBLEM_DETAIL, sourceAccess: 'private' as const },
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<ProblemEditPage code="aplusb" />);

    // Prefilled from the fetched problem, not the field's own default.
    const select = await screen.findByLabelText(/Quyền xem mã nguồn/);
    await waitFor(() => expect(select).toHaveValue('solved'));

    await userEvent.selectOptions(select, 'private');
    await userEvent.click(screen.getByRole('button', { name: /^Lưu$/ }));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalledTimes(1));
    const [, options] = mockedPatch.mock.calls[0] as unknown as [
      string,
      { body: { sourceAccess?: string } },
    ];
    expect(options.body.sourceAccess).toBe('private');
  });
});

describe('ProblemRevisionsPage', () => {
  it('a failed attach shows the server error code', async () => {
    mockedGet.mockResolvedValueOnce({
      data: [],
      error: undefined,
      response: new Response(),
    } as never);
    mockedPost.mockResolvedValueOnce({
      data: undefined,
      error: {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'package_not_found',
        detail: 'No such package.',
      },
      response: new Response(),
    } as never);

    renderWithClient(<ProblemRevisionsPage code="aplusb" />);
    await screen.findByText(/Chưa có phiên bản nào/);

    await userEvent.type(screen.getByLabelText(/^Mã băm gói$/), 'deadbeef');
    await userEvent.click(screen.getByRole('button', { name: /^Gắn$/ }));

    // Verbatim, not a paraphrase like "Something went wrong" — a setter
    // pasting a bad hash needs to see exactly `package_not_found` (task-12
    // brief).
    expect(await screen.findByText('package_not_found')).toBeInTheDocument();
  });

  it('publish is not offered for the already-published revision', async () => {
    mockedGet.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          version: 1,
          state: 'published',
          packageHash: 'a'.repeat(64),
          notes: null,
          timeMs: 1000,
          memoryKb: 65536,
          testCount: 3,
          totalPoints: 100,
          checkerKind: 'wcmp',
          createdBy: 1,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 2,
          version: 2,
          state: 'draft',
          packageHash: 'b'.repeat(64),
          notes: null,
          timeMs: 1000,
          memoryKb: 65536,
          testCount: 3,
          totalPoints: 100,
          checkerKind: 'wcmp',
          createdBy: 1,
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
      error: undefined,
      response: new Response(),
    } as never);

    renderWithClient(<ProblemRevisionsPage code="aplusb" />);
    await screen.findByText('đã công bố');
    expect(screen.getByText('bản nháp')).toBeInTheDocument();

    // Exactly one Publish button — for the draft, not the already-published
    // revision. Publishing the current revision again is a legal no-op
    // server-side, but offering the button here would invite a confusing
    // click for no effect (task-12 brief).
    const publishButtons = screen.getAllByRole('button', { name: /^Công bố$/ });
    expect(publishButtons).toHaveLength(1);
  });
});

describe('the form reseeds when the route code changes without a remount', () => {
  it('shows problem B after a param-only navigation from problem A', async () => {
    const A = { ...PROBLEM_DETAIL, code: 'aaa', name: 'Problem A', statement: 'sa', orgSlugs: [] };
    const B = { ...PROBLEM_DETAIL, code: 'bbb', name: 'Problem B', statement: 'sb', orgSlugs: [] };
    mockedGet.mockImplementation((async (_path: string, options: { params: { path: { code: string } } }) => ({
      data: options.params.path.code === 'aaa' ? A : B,
      error: undefined,
      response: new Response(),
    })) as never);

    // One client across both renders — the exact reused-instance shape the
    // router produces on a history jump between two edit URLs.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <ProblemEditPage code="aaa" />
      </QueryClientProvider>,
    );
    expect(await screen.findByDisplayValue('Problem A')).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={client}>
        <ProblemEditPage code="bbb" />
      </QueryClientProvider>,
    );
    // Before the fix the boolean `initialized` gate kept Problem A's content
    // here — the state a Save would then write over problem B.
    expect(await screen.findByDisplayValue('Problem B')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Problem A')).toBeNull();
  });
});

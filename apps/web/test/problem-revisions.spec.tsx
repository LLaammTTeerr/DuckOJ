import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { ProblemRevisionsPage } from '../src/routes/problem-revisions.js';

// Same mocking pattern as test/problems.spec.tsx: `ProblemRevisionsPage`
// reaches the network only through `api`, so mocking the module is enough.
// Unlike `ProblemsPage`/`SubmissionsPage`, this component renders no
// `<Link>`, so no router scaffold is needed here.
vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn() },
}));

const mockedGet = vi.mocked(api.GET);

afterEach(() => {
  mockedGet.mockReset();
});

function apiResponse(data: unknown) {
  return { data, error: undefined, response: new Response() };
}

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const REVISION_A = {
  id: 1,
  version: 1,
  state: 'published' as const,
  packageHash: '73d40a7e62d7019346f137048ee1f251e07cad9e4e34b8593f28a2f42f12e406',
  notes: null,
  timeMs: 1000,
  memoryKb: 65536,
  testCount: 3,
  totalPoints: 3,
  checkerKind: 'standard',
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

/**
 * Regression coverage for the same bug already fixed on `ProblemsPage`
 * (test/problems.spec.tsx): a single free-text `1000 ms / 65536 KB` cell,
 * memory shown in unreadable raw KB. This asserts the fix reuses
 * `formatMemoryMb` (imported, not re-implemented) rather than duplicating
 * "how do we render a memory limit" a second time.
 */
it('renders time and memory as separate, right-aligned numeric columns, memory in MB', async () => {
  mockedGet.mockResolvedValueOnce(apiResponse([REVISION_A]) as never);

  renderWithClient(<ProblemRevisionsPage code="aplusb" />);
  await screen.findByText('1000 ms');

  const rows = screen.getAllByRole('row');
  // rows[0] is the header row.
  expect(within(rows[0]!).getByRole('columnheader', { name: 'Time' })).toHaveClass('num');
  expect(within(rows[0]!).getByRole('columnheader', { name: 'Mem' })).toHaveClass('num');
  expect(within(rows[0]!).getByRole('columnheader', { name: 'Tests' })).toHaveClass('num');

  expect(within(rows[1]!).getByText('1000 ms')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('64 MB')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('3')).toBeInTheDocument();
  // Neither raw KB nor a concatenated "ms / KB" cell exists anywhere.
  expect(screen.queryByText(/65536 KB/)).not.toBeInTheDocument();
  expect(screen.queryByText(/ms \//)).not.toBeInTheDocument();
});

describe('ProblemRevisionsPage', () => {
  it('renders a row per revision with a publish button only for the non-published one', async () => {
    const draft = { ...REVISION_A, id: 2, version: 2, state: 'draft' as const };
    mockedGet.mockResolvedValueOnce(apiResponse([REVISION_A, draft]) as never);

    renderWithClient(<ProblemRevisionsPage code="aplusb" />);
    await screen.findAllByText('1000 ms');

    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 revisions
    expect(screen.getAllByRole('button', { name: /publish/i })).toHaveLength(1);
  });
});

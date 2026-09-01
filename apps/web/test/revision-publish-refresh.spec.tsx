/**
 * Publishing a revision moves the limits a pupil is shown (B-31).
 *
 * `handlePublish` invalidated `['problem-revisions', code]` — its own table —
 * and nothing else. But publishing is the write that changes `timeMs`,
 * `memoryKb`, `testCount`, `totalPoints`, `checkerKind` and
 * `hasPublishedRevision` on `ProblemDetail`, and that lives under
 * `['problem', code]`: a different first element, so no prefix match, exactly
 * F-42's `'org-teams'` / `'org-team'` shape.
 *
 * The moment this happens is the one D87 built the screen for — a setter
 * republishing a corrected test set — and the reader it lies to is the pupil
 * on `/problems/{code}` or in the submit box, who is quoted the time limit of
 * the revision that was just superseded.
 *
 * One `QueryClient` across both screens, because the point is what one screen
 * leaves behind for the next.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockedGet = vi.fn();
const mockedPost = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => mockedGet(...a),
    POST: (...a: unknown[]) => mockedPost(...a),
    PATCH: vi.fn(),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useBlocker: vi.fn(),
  useNavigate: () => vi.fn(),
}));

const { ProblemRevisionsPage } = await import('../src/routes/problem-revisions.js');
const { ProblemEditPage } = await import('../src/routes/problem-edit.js');

afterEach(() => {
  mockedGet.mockReset();
  mockedPost.mockReset();
});

describe('after a revision is published', () => {
  it('the problem detail the other screens read is refetched, not the pre-publish one', async () => {
    const user = userEvent.setup();
    // The server: revision 2 doubles the time limit of the published problem.
    const server = {
      published: 1,
      detail: {
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
        members: [],
        orgSlugs: [],
        editorial: null,
        editorialAvailable: false,
        tags: [],
        difficulty: null,
      },
    };
    mockedGet.mockImplementation((path: string) => {
      if (path === '/problems/{code}/revisions') {
        return Promise.resolve({
          data: [
            { id: 1, version: 1, state: server.published === 1 ? 'published' : 'superseded', packageHash: 'aaa', timeMs: 1000, memoryKb: 65536, testCount: 3, notes: null },
            { id: 2, version: 2, state: server.published === 2 ? 'published' : 'draft', packageHash: 'bbb', timeMs: 2000, memoryKb: 65536, testCount: 5, notes: null },
          ],
        });
      }
      if (path === '/problems/{code}') return Promise.resolve({ data: { ...server.detail } });
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'setter', globalRole: 'setter' } });
      if (path === '/tags') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });
    mockedPost.mockImplementation((path: string) => {
      if (path === '/problems/{code}/revisions/{version}/publish') {
        server.published = 2;
        server.detail = { ...server.detail, timeMs: 2000, testCount: 5 };
        return Promise.resolve({ data: {} });
      }
      return Promise.resolve({ data: undefined, error: { code: 'not_mocked' } });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mount = (ui: ReactElement) =>
      render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

    // The pupil's screen filled the cache first — a setter publishing a fix
    // is publishing it to a site people are already reading.
    const reader = mount(<ProblemEditPage code="aplusb" />);
    await waitFor(() => expect(screen.getByLabelText('Tên')).toHaveValue('A Plus B'));
    reader.unmount();

    // The setter publishes revision 2.
    const revisions = mount(<ProblemRevisionsPage code="aplusb" />);
    const publish = await screen.findAllByRole('button', { name: 'Công bố' });
    await user.click(publish[publish.length - 1]!);
    await waitFor(() => expect(server.published).toBe(2));
    revisions.unmount();

    // `['problem', code]` must no longer be serving 1000 ms out of the cache.
    const entry = client.getQueryState(['problem', 'aplusb']);
    expect(entry?.isInvalidated ?? false).toBe(true);
  });
});

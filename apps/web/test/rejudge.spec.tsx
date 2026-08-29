/**
 * The two Rejudge controls: one submission (`/submissions/$id`) and one
 * problem's whole history (the problem edit screen).
 *
 * Both are admin-only, both confirm first, and both hold a busy flag across
 * the request — a rejudge fired twice races two claims for the same job.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a), PATCH: vi.fn() },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { SubmissionPage } = await import('../src/routes/submission.js');
const { ProblemEditPage } = await import('../src/routes/problem-edit.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const DETAIL = {
  id: 42,
  problemCode: 'aplusb',
  languageKey: 'cpp17',
  source: 'int main() {}',
  state: 'done',
  verdict: 'AC',
  points: 100,
  maxPoints: 100,
  timeMs: 12,
  memoryKb: 1024,
  compileOutput: null,
  cases: [],
  createdAt: '2026-08-01T00:00:00Z',
  judgedAt: '2026-08-01T00:00:05Z',
};

const PROBLEM = {
  id: 1,
  code: 'aplusb',
  name: 'A Plus B',
  statement: 'Add them.',
  visibility: 'public' as const,
  hasPublishedRevision: true,
  orgSlugs: [],
  tags: [],
  difficulty: null,
  members: [],
};

/** Answers `/auth/me` with `role`, and everything else with `body`. */
function routeGet(role: string | null, body: unknown): void {
  get.mockImplementation((path: string) =>
    path === '/auth/me'
      ? Promise.resolve({ data: role === null ? undefined : { username: 'root', globalRole: role } })
      : Promise.resolve({ data: body }),
  );
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  vi.unstubAllGlobals();
});

describe('rejudging one submission', () => {
  it('is offered to an admin, confirms, and posts', async () => {
    routeGet('admin', DETAIL);
    post.mockResolvedValue({ data: { submissionId: 42, jobId: 7, ratedContestKeys: [] } });
    vi.stubGlobal('confirm', vi.fn(() => true));

    wrap(<SubmissionPage id={42} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Chấm lại' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/admin/submissions/{id}/rejudge', {
        params: { path: { id: 42 } },
      }),
    );
  });

  it('names the rated contests to re-rate, because the rejudge will not (D21)', async () => {
    routeGet('admin', DETAIL);
    post.mockResolvedValue({
      data: { submissionId: 42, jobId: 7, ratedContestKeys: ['spring-open', 'winter-cup'] },
    });
    vi.stubGlobal('confirm', vi.fn(() => true));

    wrap(<SubmissionPage id={42} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Chấm lại' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Hãy tính lại rating cho các kỳ thi này sau khi chấm xong: spring-open, winter-cup.',
    );
  });

  it('says nothing about re-rating when no rated contest was touched', async () => {
    routeGet('admin', DETAIL);
    post.mockResolvedValue({ data: { submissionId: 42, jobId: 7, ratedContestKeys: [] } });
    vi.stubGlobal('confirm', vi.fn(() => true));

    wrap(<SubmissionPage id={42} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Chấm lại' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a cancelled confirm sends nothing', async () => {
    routeGet('admin', DETAIL);
    vi.stubGlobal('confirm', vi.fn(() => false));

    wrap(<SubmissionPage id={42} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Chấm lại' }));
    expect(post).not.toHaveBeenCalled();
  });

  it('is not offered to a non-admin', async () => {
    routeGet('user', DETAIL);
    wrap(<SubmissionPage id={42} />);
    expect(await screen.findByRole('heading', { name: /bài nộp #42/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chấm lại' })).not.toBeInTheDocument();
  });

  it('reports a refusal instead of silently doing nothing', async () => {
    routeGet('admin', DETAIL);
    post.mockResolvedValue({ error: { code: 'admin_forbidden', detail: 'Only an admin may rejudge.' } });
    vi.stubGlobal('confirm', vi.fn(() => true));

    wrap(<SubmissionPage id={42} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Chấm lại' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an admin may rejudge.');
  });

  it('a transport failure does not wedge the button', async () => {
    routeGet('admin', DETAIL);
    post.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('confirm', vi.fn(() => true));

    wrap(<SubmissionPage id={42} />);
    const button = await screen.findByRole('button', { name: 'Chấm lại' });
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(/không kết nối được máy chủ/i);
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});

describe("rejudging a problem's whole history", () => {
  it('is offered to an admin on the edit screen and reports how many were queued', async () => {
    routeGet('admin', PROBLEM);
    post.mockResolvedValue({ data: { submissionsQueued: 12, ratedContestKeys: [] } });
    vi.stubGlobal('confirm', vi.fn(() => true));

    wrap(<ProblemEditPage code="aplusb" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Chấm lại toàn bộ bài nộp' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/admin/problems/{code}/rejudge', {
        params: { path: { code: 'aplusb' } },
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Đã xếp hàng 12 bài nộp.');
  });

  it('names the rated contests to re-rate beside the queued count (D21)', async () => {
    routeGet('admin', PROBLEM);
    post.mockResolvedValue({ data: { submissionsQueued: 12, ratedContestKeys: ['spring-open'] } });
    vi.stubGlobal('confirm', vi.fn(() => true));

    wrap(<ProblemEditPage code="aplusb" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Chấm lại toàn bộ bài nộp' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Đã xếp hàng 12 bài nộp.');
    expect(status).toHaveTextContent(
      'Hãy tính lại rating cho các kỳ thi này sau khi chấm xong: spring-open.',
    );
  });

  it('is not offered to a non-admin, nor when creating a new problem', async () => {
    routeGet('user', PROBLEM);
    const view = wrap(<ProblemEditPage code="aplusb" />);
    expect(await screen.findByRole('heading', { name: /sửa aplusb/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chấm lại toàn bộ bài nộp' })).not.toBeInTheDocument();
    view.unmount();

    routeGet('admin', PROBLEM);
    wrap(<ProblemEditPage />);
    expect(await screen.findByRole('heading', { name: /bài tập mới/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chấm lại toàn bộ bài nộp' })).not.toBeInTheDocument();
  });
});

/**
 * `/submissions/$id` — the page whose absence made every old submission a
 * dead end. Rendering rides the same `VerdictPanel` the live submit screen
 * uses, so only this page's own obligations are pinned here: the metadata
 * links out, the source is shown verbatim, and a 404 stays an error.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({ api: { GET: (...a: unknown[]) => get(...a) } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { SubmissionPage } = await import('../src/routes/submission.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const DETAIL = {
  id: 42,
  problemCode: 'aplusb',
  languageKey: 'cpp17',
  source: 'int main() { return 0; }',
  state: 'done',
  verdict: 'AC',
  points: 100,
  maxPoints: 100,
  timeMs: 12,
  memoryKb: 1024,
  compileOutput: null,
  cases: [
    { groupIndex: 0, caseIndex: 1, verdict: 'AC', skipped: false, timeMs: 12, memoryKb: 1024, points: 100, maxPoints: 100, feedback: null },
  ],
  createdAt: '2026-08-01T00:00:00Z',
  judgedAt: '2026-08-01T00:00:05Z',
};

afterEach(() => get.mockReset());

describe('SubmissionPage', () => {
  it('shows verdict, cases and the source verbatim', async () => {
    get.mockResolvedValue({ data: DETAIL });
    wrap(<SubmissionPage id={42} />);

    expect(await screen.findByRole('heading', { name: /submission #42/i })).toBeInTheDocument();
    expect(screen.getByText('AC')).toHaveClass('badge', 'ac');
    expect(screen.getByText('int main() { return 0; }')).toBeInTheDocument();
    // The problem is a link out, not a label.
    expect(screen.getByRole('link', { name: 'aplusb' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/submissions/{id}', { params: { path: { id: 42 } } });
  });

  it('a submission the caller may not see stays an error, not a blank page', async () => {
    get.mockResolvedValue({ data: undefined, error: { detail: 'No such submission.' } });
    wrap(<SubmissionPage id={7} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no such submission/i);
  });
});

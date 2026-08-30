/**
 * D111 — the "So sánh với lần nộp trước" toggle on `/submissions/$id`.
 *
 * The diff is server-computed; this page only renders the hunks. What is
 * pinned here is the page's own contract: the toggle appears only when a
 * previous own attempt exists, and each changed line carries a +/− glyph as
 * real text (never colour alone, B-20/D77).
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({ api: { GET: (...a: unknown[]) => get(...a) } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to?: string; params?: Record<string, string> }) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to ?? '#');
    return <a href={href}>{children}</a>;
  },
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
  source: 'int main(){\n  return 1;\n}\n',
  state: 'done',
  verdict: 'AC',
  points: 100,
  maxPoints: 100,
  timeMs: 12,
  memoryKb: 1024,
  compileOutput: null,
  cases: [],
  contestKey: null,
  contestLabel: null,
  createdAt: '2026-08-01T00:00:00Z',
  judgedAt: '2026-08-01T00:00:05Z',
  frozen: false,
  sourceHidden: false,
};

const DIFF = {
  base: { id: 42, languageKey: 'cpp17', source: 'int main(){\n  return 1;\n}\n' },
  against: { id: 30, languageKey: 'cpp17', source: 'int main(){\n  return 0;\n}\n' },
  hunks: [
    {
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 4,
      lines: [
        { op: 'context', text: 'int main(){' },
        { op: 'removed', text: '  return 0;' },
        { op: 'added', text: '  return 1;' },
        { op: 'context', text: '}' },
      ],
    },
  ],
};

/** Routes the mocked `api.GET` by path so previous/diff differ from detail. */
function route(previousId: number | null): void {
  get.mockImplementation((path: string) => {
    if (path === '/submissions/{id}/previous') return Promise.resolve({ data: { previousId } });
    if (path === '/submissions/{id}/diff') return Promise.resolve({ data: DIFF });
    return Promise.resolve({ data: DETAIL });
  });
}

afterEach(() => get.mockReset());

describe('SubmissionPage — compare with previous attempt', () => {
  it('shows the toggle and renders the diff with +/- glyphs on demand', async () => {
    route(30);
    wrap(<SubmissionPage id={42} />);

    const toggle = await screen.findByRole('button', { name: 'So sánh với lần nộp trước' });
    await userEvent.click(toggle);

    // The diff lands, with the changed lines tinted AND glyph-marked.
    const removed = await screen.findByText('return 0;', { exact: false });
    const removedLine = removed.closest('.diff-line');
    expect(removedLine).toHaveClass('diff-removed');
    expect(within(removedLine as HTMLElement).getByText('−')).toBeInTheDocument();

    const added = screen.getByText('return 1;', { exact: false, selector: '.diff-line' });
    expect(added).toHaveClass('diff-added');
    expect(within(added).getByText('+')).toBeInTheDocument();

    expect(get).toHaveBeenCalledWith('/submissions/{id}/diff', {
      params: { path: { id: 42 }, query: { against: 30 } },
    });
  });

  it('offers no toggle when there is no previous attempt', async () => {
    route(null);
    wrap(<SubmissionPage id={42} />);

    // The page has loaded (the source is on screen) but no compare button.
    await screen.findByRole('heading', { name: /Bài nộp #42/ });
    expect(screen.queryByRole('button', { name: 'So sánh với lần nộp trước' })).not.toBeInTheDocument();
  });
});

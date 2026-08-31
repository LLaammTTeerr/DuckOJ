/**
 * A frozen submission on screen (D23).
 *
 * `?` rather than the pending `—`: those are different claims. `—` says the
 * judge has not answered yet; `?` says it has and the answer is being
 * withheld until the board thaws. The reason itself is prose, so it is a
 * translated `title`, present in both locales — `i18n.spec.tsx` is what pins
 * that both locales carry the key.
 */
import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../src/i18n/index.js';

const get = vi.fn();
vi.mock('../src/api.js', () => ({ api: { GET: (...a: unknown[]) => get(...a), POST: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
}));

const { SubmissionsPage } = await import('../src/routes/submissions.js');
const { SubmissionPage } = await import('../src/routes/submission.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const OPEN = {
  id: 42,
  problemCode: 'aplusb',
  username: 'alice',
  languageKey: 'cpp17',
  state: 'done' as const,
  verdict: 'AC' as const,
  points: 100,
  maxPoints: 100,
  createdAt: '2026-01-01T00:00:00Z',
  frozen: false,
};

const HIDDEN = {
  ...OPEN,
  id: 43,
  verdict: null,
  points: null,
  frozen: true,
};

afterEach(() => get.mockReset());

describe('a frozen submission', () => {
  it('shows `?` in the list, with the reason on hover, and leaves its neighbours alone', async () => {
    get.mockResolvedValue({ data: { items: [HIDDEN, OPEN], nextCursor: null }, error: undefined });

    wrap(<SubmissionsPage />);

    const badge = await screen.findByText('?');
    expect(badge).toHaveAttribute('title', translate('vi', 'submission.frozen'));
    // The freeze is per row, never per page: the neighbouring submission,
    // made before the window opened, still says what it scored. Scoped to the
    // table because the verdict filter's <select> also offers an "AC" option.
    expect(within(screen.getByRole('table')).getByText('AC')).toHaveClass('badge', 'ac');
  });

  it('shows `?` on the submission page, where a null verdict alone would render nothing', async () => {
    get.mockResolvedValue({
      data: {
        id: 43,
        username: 'alice',
        problemCode: 'aplusb',
        languageKey: 'cpp17',
        source: 'int main(){}',
        state: 'done',
        verdict: null,
        points: null,
        maxPoints: 100,
        timeMs: null,
        memoryKb: null,
        compileOutput: null,
        cases: [],
        createdAt: '2026-08-01T00:00:00Z',
        judgedAt: '2026-08-01T00:00:05Z',
        frozen: true,
      },
    });

    wrap(<SubmissionPage id={43} />);

    const badge = await screen.findByText('?');
    expect(badge).toHaveAttribute('title', translate('vi', 'submission.frozen'));
  });

  it('has a reason to give in English too', () => {
    expect(translate('en', 'submission.frozen')).not.toBe(translate('vi', 'submission.frozen'));
    expect(translate('en', 'submission.frozen')).toMatch(/unfreez/i);
  });
});

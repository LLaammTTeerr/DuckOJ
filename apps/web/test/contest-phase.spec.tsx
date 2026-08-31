/**
 * D134 — a contest's phase is a chip beside its name, not a word in the fifth
 * column.
 *
 * What the visual audit found on the live stack: the contest list carried
 * "TRẠNG THÁI" as column five, in the same ink and the same weight as
 * everything else, so the ONE round that was running read exactly like the
 * twenty-four that had finished — and at 390px, where a contestant actually
 * looks on contest day, that column was off the right edge entirely. The one
 * question the list exists to answer ("which one is on right now?") was the
 * one it did not answer.
 *
 * The three claims here: the phase rides in the NAME cell (column one, always
 * on screen), it is a chip carrying a glyph as well as its word (colour is
 * never the only cue — D46/D77), and the separate column is gone.
 */
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: vi.fn() },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { ContestsPage } = await import('../src/routes/contests.js');
const { LocaleProvider } = await import('../src/i18n/index.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider initialLocale="vi">{ui}</LocaleProvider>
    </QueryClientProvider>,
  );
}

const HOUR = 3_600_000;
function contest(key: string, name: string, startsIn: number, endsIn: number) {
  return {
    id: 1,
    key,
    name,
    format: 'icpc',
    startTime: new Date(Date.now() + startsIn).toISOString(),
    endTime: new Date(Date.now() + endsIn).toISOString(),
    orgs: [],
    visibility: 'public' as const,
    isRated: false,
    pointsPrecision: 3,
    frozenLastMinutes: 0,
    timeLimitSeconds: null,
    participationMode: 'individual' as const,
    maxTeamSize: 3,
    createdAt: new Date().toISOString(),
  };
}

const ITEMS = [
  contest('done', 'Vòng đã xong', -5 * HOUR, -3 * HOUR),
  contest('live', 'Vòng đang chạy', -HOUR, HOUR),
  contest('soon', 'Vòng sắp tới', 3 * HOUR, 5 * HOUR),
];

afterEach(() => {
  get.mockReset();
});

function serve(): void {
  get.mockImplementation((path: string) => {
    if (path === '/auth/me') return Promise.resolve({ data: undefined });
    if (path === '/contests') return Promise.resolve({ data: { items: ITEMS, nextCursor: null } });
    return Promise.resolve({ data: null });
  });
}

describe('the phase of a contest on the list (D134)', () => {
  it('rides in the name cell, so it is on screen at every width', async () => {
    serve();
    wrap(<ContestsPage />);
    await screen.findByRole('link', { name: 'Vòng đang chạy' });

    for (const [name, word] of [
      ['Vòng đã xong', 'đã kết thúc'],
      ['Vòng đang chạy', 'đang diễn ra'],
      ['Vòng sắp tới', 'sắp diễn ra'],
    ] as const) {
      const cell = screen.getByRole('link', { name }).closest('td');
      expect(cell, `${name} has no name cell`).not.toBeNull();
      // The phase is in the SAME cell as the link the reader is looking at.
      expect(within(cell!).getByText(word)).toHaveClass('phase');
    }
  });

  it('marks each phase by shape as well as by weight, never by colour alone', async () => {
    serve();
    wrap(<ContestsPage />);
    await screen.findByRole('link', { name: 'Vòng đang chạy' });

    // One class per phase, so `.phase::before` can give each its own glyph
    // (D46/D77: a state signalled by colour alone is a state a colour-blind
    // reader and a monochrome print both lose).
    expect(screen.getByText('đang diễn ra')).toHaveClass('phase', 'running');
    expect(screen.getByText('sắp diễn ra')).toHaveClass('phase', 'upcoming');
    expect(screen.getByText('đã kết thúc')).toHaveClass('phase', 'finished');
  });

  it('no longer spends a whole column on it', async () => {
    serve();
    wrap(<ContestsPage />);
    await screen.findByRole('link', { name: 'Vòng đang chạy' });

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('Trạng thái');
    // …and the columns that are left are the ones that carry data the chip
    // does not: format, the two instants, and the org restriction.
    expect(headers).toEqual(['Kỳ thi', 'Thể thức', 'Bắt đầu', 'Kết thúc', 'Dành cho']);
  });
});

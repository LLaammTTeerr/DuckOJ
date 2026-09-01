/**
 * A pupil's rating curve is the WHOLE curve, and the number above it is
 * today's (D187).
 *
 * **The defect this pins.** `progress.tsx` built the rating history as a
 * `useInfiniteQuery` and never rendered a "load more" anywhere on the page,
 * so it served exactly one page — a pupil's first hundred rated contests —
 * with no signal of any kind. D178 recorded it and left it.
 *
 * It is worse than a truncated list, which is the whole reason this one is
 * walked to exhaustion rather than given a button. The history ASCENDS by
 * time, and the page reads its headline rating off the last row loaded. Past
 * a hundred rounds, a pupil's own progress page printed the rating they held
 * at their hundredth contest as their rating today — a wrong number, not a
 * short list — and drew a sparkline that stopped there with no visible end.
 *
 * So the assertion is not "a button exists". It is that the second page was
 * asked for with the FIRST page's cursor, unprompted, and that the headline
 * number comes from the last event in the whole history.
 */
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: Record<string, unknown>) => <a href={String(to)}>{children as React.ReactNode}</a>,
}));

const { MyProgressPage } = await import('../src/routes/progress.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = { username: 'hs000001', displayName: 'Nguyễn Văn An', globalRole: 'user' };

const PROGRESS = {
  byTag: [],
  byDifficulty: [],
  heatmap: { timezone: 'Asia/Ho_Chi_Minh', from: '2026-01-01', to: '2026-01-14', days: [] },
  streak: { current: 0, longest: 0, lastDate: null },
  recent: [],
  upcomingContests: [],
  homework: [],
};

/** A rating event, `ratingAfter` being the only field this page reads. */
function event(id: number, ratingAfter: number) {
  return {
    contestKey: `vong-${String(id)}`,
    contestName: `Vòng ${String(id)}`,
    endTime: '2026-01-01T00:00:00Z',
    rank: 1,
    ratingBefore: ratingAfter - 1,
    ratingAfter,
    delta: 1,
  };
}

afterEach(() => {
  get.mockReset();
});

describe("a pupil past a hundred rated contests (D187)", () => {
  it('walks the whole history unprompted, and reads today’s rating off the end of it', async () => {
    const cursors: (string | undefined)[] = [];
    get.mockImplementation((path: string, init?: Record<string, unknown>) => {
      if (path === '/auth/me') return Promise.resolve({ data: ME });
      if (path === '/users/me/progress') return Promise.resolve({ data: PROGRESS });
      if (path === '/users/{username}/rating') {
        const cursor = (init?.params as { query?: { cursor?: string } } | undefined)?.query?.cursor;
        cursors.push(cursor);
        return Promise.resolve(
          cursor === undefined
            ? {
                data: {
                  items: Array.from({ length: 100 }, (_, i) => event(i + 1, 1200 + i)),
                  nextCursor: '100_777',
                },
                response: { status: 200 },
              }
            : {
                data: { items: [event(101, 1899)], nextCursor: null },
                response: { status: 200 },
              },
        );
      }
      return Promise.resolve({ data: undefined });
    });

    wrap(<MyProgressPage />);

    // 1899 is the hundred-and-FIRST event. Before D187 the page showed 1299 —
    // the hundredth — and nothing said it was stale.
    expect(await screen.findByText(/· 1899$/)).toBeTruthy();

    // And it got there by taking the cursor the server issued, not by asking
    // for page one twice and not by waiting for a press.
    expect(cursors).toEqual([undefined, '100_777']);
  });
});

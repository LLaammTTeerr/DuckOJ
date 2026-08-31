/**
 * The states nobody designs: loading, empty, failing, offline (D143–D145).
 *
 * Every case here is a screen a contest-day reader on school wifi actually
 * sees, and each was measured in Chromium against `vite preview` with
 * `page.route` before it was written down:
 *
 *  - a 500 on `/contests/probe-cup` painted **"Không có kỳ thi này."** — the
 *    contest exists, the request failed, and the app told a competitor at the
 *    bell that their round is not there. Same lie on the problem page, the
 *    org page and the submission page, because `apiError(result, fallback)`
 *    hands ONE fallback to every status and the fallback these call sites
 *    chose is their not-found sentence.
 *  - no failing screen anywhere offered a way to ask again.
 *  - a 401 painted the server's English `detail` ("You must be signed in.")
 *    verbatim on a Vietnamese page.
 *  - nothing in `src/` ever read `navigator.onLine`, so a dead wifi looked
 *    exactly like a working one holding stale numbers.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api-error.js';
import {
  LoadError,
  OfflineBanner,
  SkeletonRows,
  StaleNotice,
  useLastError,
  useOnline,
} from '../src/states.js';

describe('LoadError — the headline follows the STATUS', () => {
  it('does not say "no such contest" when the server broke', () => {
    render(<LoadError error={new ApiError(500, 'Không có kỳ thi này.')} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Máy chủ đang gặp sự cố/);
    expect(screen.queryByText(/Không có kỳ thi này/)).not.toBeInTheDocument();
  });

  it('names the connection, not the server, when no response came back at all', () => {
    render(<LoadError error={new ApiError(0, 'Không tải được bảng điểm.')} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Không kết nối được máy chủ/);
  });

  it('keeps the caller’s not-found sentence for an actual 404', () => {
    render(<LoadError error={new ApiError(404, 'Không có kỳ thi này.')} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Không có kỳ thi này/);
  });

  it('translates a 401 rather than printing the server’s English detail as the headline', () => {
    render(<LoadError error={new ApiError(401, 'You must be signed in.', 'unauthenticated', 'You must be signed in.')} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Đăng nhập để xem trang này/);
    // The server's own wording is not thrown away — api-error.ts's ruling —
    // it just stops being the first thing a Vietnamese reader meets.
    expect(alert).toHaveTextContent(/You must be signed in/);
  });

  it('translates a 403', () => {
    render(<LoadError error={new ApiError(403, 'nope')} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/không có quyền/i);
  });

  it('treats a thrown non-ApiError as a connection failure rather than blanking', () => {
    render(<LoadError error={new Error('boom')} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Không kết nối được máy chủ/);
  });
});

describe('LoadError — naming the panel', () => {
  it('leads with WHAT failed and keeps the status sentence under it', () => {
    // The admin dashboard shows six panels at once; "the server had a
    // problem" alone does not tell an operator which one is down.
    render(<LoadError error={new ApiError(500, 'x')} what="Không tải được bảng vận hành." />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent?.indexOf('Không tải được bảng vận hành.')).toBe(0);
    expect(alert).toHaveTextContent(/Máy chủ đang gặp sự cố/);
  });

  it('does not say the same sentence twice', () => {
    render(<LoadError error={new ApiError(0, 'x')} what="Không kết nối được máy chủ. Kiểm tra đường truyền rồi thử lại." />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text.split('Không kết nối được máy chủ')).toHaveLength(2);
  });
});

describe('LoadError — the action', () => {
  it('offers Thử lại for a failure that asking again could fix', async () => {
    const retry = vi.fn();
    render(<LoadError error={new ApiError(500, 'x')} onRetry={retry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('does not offer Thử lại for a 404 — the server already gave its final answer', () => {
    render(<LoadError error={new ApiError(404, 'Không có bài tập này.')} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Thử lại' })).not.toBeInTheDocument();
  });
});

describe('SkeletonRows — space is reserved, not filled in later', () => {
  it('draws the same number of rows and columns the real table will', () => {
    const { container } = render(
      <table>
        <tbody>
          <SkeletonRows rows={4} columns={3} />
        </tbody>
      </table>,
    );
    expect(container.querySelectorAll('tr')).toHaveLength(4);
    expect(container.querySelectorAll('td')).toHaveLength(12);
  });

  it('reserves the space without adding eight empty rows to the reading order', () => {
    // `aria-hidden` is why `getAllByRole('row')` finds nothing here: the rows
    // exist for LAYOUT and for nothing else. What a reader is told about the
    // wait is the caller's own live region, said once.
    const { container } = render(
      <table>
        <tbody>
          <SkeletonRows rows={2} columns={2} />
        </tbody>
      </table>,
    );
    expect(container.querySelector('tr')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });
});

describe('OfflineBanner', () => {
  function setOnline(value: boolean) {
    Object.defineProperty(globalThis.navigator, 'onLine', { value, configurable: true });
  }

  it('says nothing while the connection is up', () => {
    setOnline(true);
    render(<OfflineBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('appears the moment the browser goes offline, without a reload', () => {
    setOnline(true);
    render(<OfflineBanner />);
    setOnline(false);
    act(() => {
      globalThis.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('status')).toHaveTextContent(/Mất kết nối/);
  });

  it('goes away again when the connection comes back', () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    setOnline(true);
    act(() => {
      globalThis.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('exposes the same fact as a hook for a screen that polls', () => {
    setOnline(false);
    function Probe() {
      return <p>{useOnline() ? 'up' : 'down'}</p>;
    }
    render(<Probe />);
    expect(screen.getByText('down')).toBeInTheDocument();
  });
});

describe('useLastError — a polling query forgets that it failed', () => {
  /**
   * TanStack Query's `fetchState()`: when a fetch STARTS and `data ===
   * undefined`, it resets `error` to null and `status` to `'pending'`. A
   * screen that polls therefore drops back to "loading" between attempts,
   * which is what `/contests/…/monitor` did for sixteen seconds of solid
   * 500s in Chromium while saying nothing.
   */
  function Probe({ error, hasData }: { error: unknown; hasData: boolean }) {
    const last = useLastError(error, hasData);
    return <p>{last === null || last === undefined ? 'none' : String((last as Error).message)}</p>;
  }

  it('holds the failure across the reset the next attempt performs', () => {
    const { rerender } = render(<Probe error={new Error('boom')} hasData={false} />);
    expect(screen.getByText('boom')).toBeInTheDocument();
    // The next poll begins: TanStack clears `error` although nothing has
    // succeeded.
    rerender(<Probe error={null} hasData={false} />);
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('forgets it the moment a poll actually succeeds', () => {
    const { rerender } = render(<Probe error={new Error('boom')} hasData={false} />);
    rerender(<Probe error={null} hasData />);
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});

describe('StaleNotice — a polling screen says when its numbers are from', () => {
  it('prints the time of the last successful poll — quietly', () => {
    const at = new Date('2026-08-31T09:41:07.000Z').getTime();
    render(<StaleNotice updatedAt={at} intervalMs={5000} now={at + 1000} />);
    expect(screen.getByText(/Cập nhật lúc/)).toBeInTheDocument();
    // NOT a live region while it is healthy: on the monitor this line moves
    // every five seconds, and a screen reader would read it out every time.
    // It is also not the page's live region — the contest page's phase
    // banner and the scoreboard's freeze banner are.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says the numbers are stale once the poll has missed twice over', () => {
    const at = Date.now();
    render(<StaleNotice updatedAt={at} intervalMs={5000} now={at + 30_000} />);
    expect(screen.getByRole('status')).toHaveTextContent(/chưa cập nhật/i);
  });

  it('says nothing at all before the first successful poll', () => {
    const { container } = render(<StaleNotice updatedAt={0} intervalMs={5000} now={Date.now()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

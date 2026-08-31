/**
 * The live contest countdown in the header (D118).
 *
 * Three claims: the number is a plain zero-padded `HH:MM:SS` with uncapped
 * hours, the label counts DOWN to the start and then to the end — flipping at
 * the gun without the parent re-rendering — and it is gone once the contest
 * has finished. The interval it ticks on is cleared when the line unmounts.
 */
import type { ReactElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { ContestCountdown } = await import('../src/routes/contests.js');
const { formatCountdown } = await import('../src/format.js');
const { LocaleProvider } = await import('../src/i18n/index.js');

function wrap(ui: ReactElement, locale: 'vi' | 'en' = 'vi') {
  return render(<LocaleProvider initialLocale={locale}>{ui}</LocaleProvider>);
}

const NOW = '2026-03-01T00:00:00Z';
const at = (secondsFromNow: number) => new Date(Date.parse(NOW) + secondsFromNow * 1000).toISOString();

describe('formatCountdown', () => {
  it('zero-pads HH:MM:SS, never caps the hours, and clamps the past to zero', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(1000)).toBe('00:00:01');
    expect(formatCountdown(3_661_000)).toBe('01:01:01');
    // Days-away upcoming contest: the hours run past 24 rather than losing them.
    expect(formatCountdown(72 * 3_600_000 + 15_000)).toBe('72:00:15');
    // A clock that has run out never prints a minus sign.
    expect(formatCountdown(-5_000)).toBe('00:00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00:00');
  });
});

describe('the header countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('counts down to the start, then flips to the end at the gun, each second', () => {
    wrap(<ContestCountdown startTime={at(2)} endTime={at(100)} />);

    const timer = screen.getByRole('timer');
    expect(timer.textContent).toContain('Bắt đầu sau');
    expect(timer.textContent).toContain('00:00:02');

    // One tick later the number has moved — the line is live.
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('timer').textContent).toContain('00:00:01');

    // Past the start: the SAME line now counts down to the end, no parent
    // re-render needed — the phase is derived here every tick.
    act(() => vi.advanceTimersByTime(2000));
    const running = screen.getByRole('timer');
    expect(running.textContent).toContain('Kết thúc sau');
    expect(running.textContent).toContain('00:01:37'); // 100 - 3 seconds
  });

  it('speaks English when the locale is English', () => {
    wrap(<ContestCountdown startTime={at(-10)} endTime={at(90)} />, 'en');
    expect(screen.getByRole('timer').textContent).toContain('Ends in');
    expect(screen.getByRole('timer').textContent).toContain('00:01:30');
  });

  it('shows nothing once the contest has finished', () => {
    wrap(<ContestCountdown startTime={at(-100)} endTime={at(-1)} />);
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('clears its interval on unmount', () => {
    const { unmount } = wrap(<ContestCountdown startTime={at(60)} endTime={at(3600)} />);
    // The one-second interval is pending while it is mounted.
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

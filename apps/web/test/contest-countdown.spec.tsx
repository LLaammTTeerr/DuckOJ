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
const { formatCountdown, formatCountdownParts } = await import('../src/format.js');
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

describe('formatCountdownParts', () => {
  it('splits whole days off the clock so a long wait is readable (D135)', () => {
    expect(formatCountdownParts(0)).toEqual({ days: 0, clock: '00:00:00' });
    expect(formatCountdownParts(3_661_000)).toEqual({ days: 0, clock: '01:01:01' });
    // 23:59:59 is still one clock — the day only appears once there is one.
    expect(formatCountdownParts(24 * 3_600_000 - 1000)).toEqual({ days: 0, clock: '23:59:59' });
    expect(formatCountdownParts(24 * 3_600_000)).toEqual({ days: 1, clock: '00:00:00' });
    // The month-long contest the live stack actually carries: 671:53:57.
    expect(formatCountdownParts(671 * 3_600_000 + 53 * 60_000 + 57_000)).toEqual({
      days: 27,
      clock: '23:53:57',
    });
    expect(formatCountdownParts(-5_000)).toEqual({ days: 0, clock: '00:00:00' });
    expect(formatCountdownParts(Number.NaN)).toEqual({ days: 0, clock: '00:00:00' });
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

  it('carries the .countdown class so its digits are tabular (no per-second reflow)', () => {
    // The number changes every second; in a proportional face a "1" is
    // narrower than a "0", so the line jitters sideways once a second unless
    // the digits are tabular. The class is where app.css pins that (D118 —
    // "no layout shift each second").
    wrap(<ContestCountdown startTime={at(2)} endTime={at(100)} />);
    expect(screen.getByRole('timer')).toHaveClass('countdown');
  });

  it('counts a wait of a day or more in days, not in three-digit hours (D135)', () => {
    // A teacher scheduling next month's round saw "Bắt đầu sau 671:53:57".
    // Nobody reads a three-digit hour as "four weeks away".
    const ms = 27 * 24 * 3_600_000 + 23 * 3_600_000 + 53 * 60_000 + 57_000;
    wrap(<ContestCountdown startTime={at(ms / 1000)} endTime={at(ms / 1000 + 7200)} />);
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('Bắt đầu sau 27 ngày 23:53:57');
    expect(timer.textContent).not.toContain('671');
  });

  it('keeps the bare clock inside the last day, which is what contest day is', () => {
    wrap(<ContestCountdown startTime={at(-10)} endTime={at(23 * 3600 + 59 * 60 + 49)} />);
    expect(screen.getByRole('timer').textContent).toBe('Kết thúc sau 23:59:49');
  });

  it('counts days in English too', () => {
    wrap(<ContestCountdown startTime={at(2 * 24 * 3600 + 3600)} endTime={at(9 * 24 * 3600)} />, 'en');
    expect(screen.getByRole('timer').textContent).toBe('Starts in 2d 01:00:00');
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

/**
 * The organiser's live monitor screen (D95).
 *
 * Two layers, in the order this suite uses everywhere: the socket hook on its
 * own (a stubbed transport, real React effects, real closures — the shape
 * `submission-socket.spec.tsx` established), then the page, whose claims are
 * that it shows the numbers, links every entity, and keeps working when the
 * socket does not.
 */
import type { ReactElement } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { ContestMonitorPage, useContestActivity } = await import('../src/routes/contest-monitor.js');

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  listeners: Record<string, ((event: unknown) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  simulateServerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  simulateMessage(data: unknown): void {
    this.emit('message', { data: JSON.stringify(data) });
  }

  private emit(type: string, event: unknown = {}): void {
    for (const cb of this.listeners[type] ?? []) cb(event);
  }
}

const SNAPSHOT = {
  problems: [
    { code: 'aplusb', label: 'A', submitted: 40, accepted: 12, solvers: 9, pending: 3 },
    { code: 'gcd', label: 'B', submitted: 0, accepted: 0, solvers: 0, pending: 0 },
  ],
  queue: { depth: 3, oldestPendingSeconds: 42 },
  judges: { online: 2, total: 3 },
  feed: [
    {
      submissionId: 77,
      username: 'an',
      problemCode: 'aplusb',
      problemLabel: 'A',
      state: 'done',
      verdict: 'AC',
      createdAt: '2026-08-30T02:00:00.000Z',
    },
    {
      submissionId: 76,
      username: 'binh',
      problemCode: 'aplusb',
      problemLabel: 'A',
      state: 'grading',
      verdict: null,
      createdAt: '2026-08-30T01:59:00.000Z',
    },
  ],
  clarifications: {
    unanswered: 4,
    latest: [
      {
        id: 5,
        problemCode: 'aplusb',
        askedBy: 'cuong',
        question: 'Giới hạn n là bao nhiêu?',
        createdAt: '2026-08-30T01:58:00.000Z',
      },
    ],
  },
  participantsOnline: 118,
  submitRefusalsLast10Min: 6,
  generatedAt: '2026-08-30T02:00:05.000Z',
};

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  get.mockReset();
  get.mockResolvedValue({ data: SNAPSHOT });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useContestActivity', () => {
  it('watches the contest on open and refetches on every activity frame', () => {
    const onActivity = vi.fn();
    renderHook(() => useContestActivity('spring', onActivity));

    const ws = FakeWebSocket.instances[0]!;
    // Same origin, and no credential anywhere in the URL — the gateway reads
    // the session cookie (D1's rule, which this page inherits).
    expect(ws.url).toMatch(/^ws:\/\/[^/]+\/ws$/);
    expect(ws.url).not.toMatch(/token|session/i);

    act(() => ws.simulateOpen());
    expect(ws.sent).toEqual([JSON.stringify({ type: 'watch-contest', key: 'spring' })]);
    // Nothing has been confirmed yet, so nothing has been refetched.
    expect(onActivity).not.toHaveBeenCalled();

    act(() => ws.simulateMessage({ type: 'contest-watched', key: 'spring' }));
    expect(onActivity).toHaveBeenCalledTimes(1);

    act(() => ws.simulateMessage({ type: 'contest-activity', key: 'spring' }));
    expect(onActivity).toHaveBeenCalledTimes(2);

    // Another contest's activity down a shared socket is not this page's.
    act(() => ws.simulateMessage({ type: 'contest-activity', key: 'autumn' }));
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it('stops reconnecting once the server has refused the watch', () => {
    vi.useFakeTimers();
    const onActivity = vi.fn();
    const onRefused = vi.fn();
    renderHook(() => useContestActivity('spring', onActivity, onRefused));

    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.simulateOpen());
    act(() => ws.simulateMessage({ type: 'error', code: 'contest_forbidden' }));

    expect(onRefused).toHaveBeenCalledWith('contest_forbidden');
    // The refusal closes the socket, and the close must NOT schedule a
    // reconnect: a caller the server said no to will be told no again, and an
    // organiser's tab open for three hours would otherwise reopen the socket
    // every ten seconds for all of them.
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reconnects after the network drops it, and watches again', () => {
    vi.useFakeTimers();
    renderHook(() => useContestActivity('spring', vi.fn()));

    const first = FakeWebSocket.instances[0]!;
    act(() => first.simulateOpen());
    act(() => first.simulateServerClose());
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1]!;
    act(() => second.simulateOpen());
    expect(second.sent).toEqual([JSON.stringify({ type: 'watch-contest', key: 'spring' })]);
  });
});

describe('the monitor page', () => {
  it('shows the tiles, the per-problem numbers and the feed, with every entity linked', async () => {
    wrap(<ContestMonitorPage contestKey="spring" />);

    // The tiles.
    expect(await screen.findByText('118')).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('2/3')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();

    // The per-problem row, including the problem nobody has touched.
    expect(screen.getByText('40')).toBeTruthy();
    // The problem cell links by label and code together; the clarification
    // row links the same problem by code alone, so there is more than one.
    expect(screen.getAllByRole('link', { name: /aplusb/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /gcd/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /12/ })).toBeTruthy();

    // The feed: a real verdict, a still-grading row, and the two people.
    expect(screen.getByText('AC')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'an' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'binh' })).toBeTruthy();

    // The unanswered question, and who asked it.
    expect(screen.getByText('Giới hạn n là bao nhiêu?')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'cuong' })).toBeTruthy();
  });

  it('says so, and keeps polling, when the socket is refused', async () => {
    wrap(<ContestMonitorPage contestKey="spring" />);
    await screen.findByText('118');
    const ws = FakeWebSocket.instances[0]!;

    act(() => ws.simulateOpen());
    act(() => ws.simulateMessage({ type: 'error', code: 'contest_forbidden' }));

    // The page does not go blank or throw: it says the accelerator is gone
    // and carries on with the five-second poll, which is the whole point of
    // the socket being an accelerator rather than a dependency.
    await waitFor(() => {
      // The note that live updates are gone — matched by its own key's text
      // rather than by a stray digit, which every table cell also has.
      expect(screen.getByText(/không nhận được cập nhật tức thời/)).toBeTruthy();
    });
    expect(screen.getByText('118')).toBeTruthy();
  });

  it('surfaces a failed read instead of an empty screen', async () => {
    get.mockResolvedValue({ error: { status: 403, detail: 'nope', code: 'contest_forbidden' } });
    wrap(<ContestMonitorPage contestKey="spring" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

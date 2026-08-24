import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubmissionSocket } from '../src/routes/submit.js';

/**
 * Regression coverage for the socket layer the manual Task 15 check
 * exercises and nothing else in this suite guards: subscribe-before-fetch
 * (D2), reconnect-then-resubscribe, id filtering, malformed-frame safety,
 * the <StrictMode> double-mount cleanup (D3), and the same-origin /
 * no-credential-in-the-URL invariant (D1). A stubbed `WebSocket` stands in
 * for the transport; StrictMode's double-invoke, React's real effect
 * scheduling, and the hook's real closures are all genuine.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  closeCalls = 0;
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

  // Mirrors the real spec: closing while CONNECTING is legal, transitions
  // straight to CLOSED without ever having fired 'open', and still fires a
  // 'close' event.
  close(): void {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  // A close the *server* (or the network) initiated, as opposed to our own
  // cleanup calling .close() — this is the leg that should trigger a
  // reconnect, unlike a close from our own disposed cleanup.
  simulateServerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  simulateMessage(data: unknown): void {
    this.emit('message', { data: JSON.stringify(data) });
  }

  simulateRawMessage(raw: string): void {
    this.emit('message', { data: raw });
  }

  private emit(type: string, event: unknown = {}): void {
    for (const cb of this.listeners[type] ?? []) cb(event);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useSubmissionSocket', () => {
  it('subscribes before it fetches, on the initial connection (D2)', () => {
    // A single shared `order` array, written to by *both* the fake send and
    // the fetch mock, is what actually proves relative ordering — recording
    // fetch calls alone would pass even if send happened after them.
    const order: string[] = [];
    const fetchSubmission = vi.fn(async (id: number) => {
      order.push(`fetch:${id}`);
    });
    const terminalRef = { current: false };

    renderHook(() => useSubmissionSocket(42, fetchSubmission, terminalRef));

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    const realSend = ws.send.bind(ws);
    ws.send = (data: string) => {
      order.push(`send:${data}`);
      realSend(data);
    };

    act(() => {
      ws.simulateOpen();
    });

    expect(ws.sent).toEqual([JSON.stringify({ type: 'subscribe', submissionId: 42 })]);
    expect(order).toEqual([`send:${JSON.stringify({ type: 'subscribe', submissionId: 42 })}`, 'fetch:42']);
    expect(fetchSubmission).toHaveBeenCalledTimes(1);
  });

  it("re-fetches on the gateway's 'subscribed' ack — the authoritative gap-closer", () => {
    // The open-time fetch races the server-side subscriptions.add; a
    // terminal publish in that window was permanently dropped. The ack
    // proves the subscription is live, so the fetch it triggers is the one
    // that closes the gap. Before the fix nothing listened for this frame.
    const fetchSubmission = vi.fn(async () => {});
    const terminalRef = { current: false };
    renderHook(() => useSubmissionSocket(42, fetchSubmission, terminalRef));
    const ws = FakeWebSocket.instances[0]!;
    act(() => {
      ws.simulateOpen();
    });
    expect(fetchSubmission).toHaveBeenCalledTimes(1); // provisional, on open

    act(() => {
      ws.simulateMessage({ type: 'subscribed', id: 42 });
    });
    expect(fetchSubmission).toHaveBeenCalledTimes(2); // authoritative, on ack

    // An ack for some other submission is ignored like any stray frame.
    act(() => {
      ws.simulateMessage({ type: 'subscribed', id: 7 });
    });
    expect(fetchSubmission).toHaveBeenCalledTimes(2);
  });

  it('resubscribes (before re-fetching) on the reconnected socket after a non-terminal close', async () => {
    const order: string[] = [];
    const fetchSubmission = vi.fn(async (id: number) => {
      order.push(`fetch:${id}`);
    });
    const terminalRef = { current: false };

    renderHook(() => useSubmissionSocket(7, fetchSubmission, terminalRef));

    const first = FakeWebSocket.instances[0]!;
    act(() => {
      first.simulateOpen();
    });
    expect(fetchSubmission).toHaveBeenCalledTimes(1);

    // The server (or the network) drops the connection — not our cleanup.
    act(() => {
      first.simulateServerClose();
    });
    expect(FakeWebSocket.instances).toHaveLength(1); // not yet — still backing off

    // First backoff delay is 1000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1]!;
    expect(second.sent).toEqual([]); // hasn't opened yet

    order.length = 0;
    const realSend = second.send.bind(second);
    second.send = (data: string) => {
      order.push(`send:${data}`);
      realSend(data);
    };

    act(() => {
      second.simulateOpen();
    });

    expect(second.sent).toEqual([JSON.stringify({ type: 'subscribe', submissionId: 7 })]);
    expect(fetchSubmission).toHaveBeenCalledTimes(2);
    // The reconnected socket subscribes-then-fetches too — this is the leg
    // a naive fix (subscribe once, reconnect straight into fetching) would
    // silently drop.
    expect(order).toEqual([`send:${JSON.stringify({ type: 'subscribe', submissionId: 7 })}`, 'fetch:7']);
  });

  it('stops reconnecting once the submission is terminal', async () => {
    const fetchSubmission = vi.fn(async () => {});
    const terminalRef = { current: true }; // already terminal when the close happens

    renderHook(() => useSubmissionSocket(1, fetchSubmission, terminalRef));
    const ws = FakeWebSocket.instances[0]!;
    act(() => {
      ws.simulateOpen();
    });

    act(() => {
      ws.simulateServerClose();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect at all
  });

  it('ignores frames for other submission ids and re-fetches only on a match', () => {
    const fetchSubmission = vi.fn(async () => {});
    const terminalRef = { current: false };

    renderHook(() => useSubmissionSocket(42, fetchSubmission, terminalRef));
    const ws = FakeWebSocket.instances[0]!;
    act(() => {
      ws.simulateOpen();
    });
    expect(fetchSubmission).toHaveBeenCalledTimes(1); // the post-subscribe fetch

    act(() => {
      ws.simulateMessage({ type: 'submission', id: 999 });
    });
    expect(fetchSubmission).toHaveBeenCalledTimes(1); // unchanged

    act(() => {
      ws.simulateMessage({ type: 'submission', id: 42 });
    });
    expect(fetchSubmission).toHaveBeenCalledTimes(2);
  });

  it('does not throw on malformed frames: non-JSON, null, an array, or an unrecognised type', () => {
    const fetchSubmission = vi.fn(async () => {});
    const terminalRef = { current: false };

    renderHook(() => useSubmissionSocket(42, fetchSubmission, terminalRef));
    const ws = FakeWebSocket.instances[0]!;
    act(() => {
      ws.simulateOpen();
    });
    fetchSubmission.mockClear();

    expect(() => {
      act(() => {
        ws.simulateRawMessage('not valid json{');
      });
    }).not.toThrow();

    expect(() => {
      act(() => {
        ws.simulateMessage(null);
      });
    }).not.toThrow();

    expect(() => {
      act(() => {
        ws.simulateMessage([1, 2, 3]);
      });
    }).not.toThrow();

    expect(() => {
      act(() => {
        ws.simulateMessage({ type: 'something-unrecognised' });
      });
    }).not.toThrow();

    // None of the above is a matching `submission` frame, so none of them
    // triggers a re-fetch.
    expect(fetchSubmission).not.toHaveBeenCalled();
  });

  it('surfaces a rejected-subscription frame via onSubscriptionError, using the gateway code', () => {
    const fetchSubmission = vi.fn(async () => {});
    const terminalRef = { current: false };
    const onSubscriptionError = vi.fn();

    renderHook(() => useSubmissionSocket(42, fetchSubmission, terminalRef, onSubscriptionError));
    const ws = FakeWebSocket.instances[0]!;
    act(() => {
      ws.simulateOpen();
    });

    act(() => {
      ws.simulateMessage({ type: 'error', code: 'submission_not_found' });
    });

    expect(onSubscriptionError).toHaveBeenCalledWith('submission_not_found');
  });

  it('carries no query string in the constructed WebSocket URL — no credential ever goes in the URL', () => {
    const fetchSubmission = vi.fn(async () => {});
    const terminalRef = { current: false };

    renderHook(() => useSubmissionSocket(42, fetchSubmission, terminalRef));
    const ws = FakeWebSocket.instances[0]!;

    expect(ws.url).toMatch(/^wss?:\/\/[^/]+\/ws$/);
    expect(new URL(ws.url).search).toBe('');
    expect(ws.url).not.toContain('?');
    expect(ws.url).not.toContain('token');
  });

  it('under <StrictMode> with an id already truthy at first render, closes the discarded socket while CONNECTING and never reconnects it', async () => {
    const fetchSubmission = vi.fn(async () => {});
    const terminalRef = { current: false };

    renderHook(() => useSubmissionSocket(42, fetchSubmission, terminalRef), { wrapper: StrictMode });

    expect(FakeWebSocket.instances).toHaveLength(2);
    const [discarded, surviving] = FakeWebSocket.instances;

    expect(discarded!.closeCalls).toBeGreaterThanOrEqual(1);
    expect(discarded!.sent).toEqual([]); // never got far enough to open or send

    act(() => {
      surviving!.simulateOpen();
    });
    expect(surviving!.sent).toEqual([JSON.stringify({ type: 'subscribe', submissionId: 42 })]);
    expect(fetchSubmission).toHaveBeenCalledTimes(1);

    // The discarded socket's own close handler must not have scheduled a
    // reconnect from an orphaned closure: waiting past the first backoff
    // delay must not produce a third socket.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

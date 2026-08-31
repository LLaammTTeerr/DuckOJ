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

/**
 * The reconnect storm.
 *
 * `attempt` was reset the moment the socket fired `open`, which is not
 * evidence of anything: an API restarting, a proxy draining, or the
 * gateway's own `onModuleDestroy` all accept the upgrade and then close it
 * immediately. Each cycle reset the backoff, so every open tab hammered
 * `/ws` once a second, forever, and the ladder past 1000 ms was unreachable
 * in exactly the situation it exists for. The backoff is reset by the
 * gateway's `subscribed` ack instead — the one frame that proves the
 * connection did something useful.
 */
describe('useSubmissionSocket — reconnect backoff', () => {
  function connectThenDrop(times: number, fetchSubmission: (id: number) => Promise<void>) {
    const terminalRef = { current: false };
    renderHook(() => useSubmissionSocket(7, fetchSubmission, terminalRef));
    for (let i = 0; i < times; i += 1) {
      const ws = FakeWebSocket.instances.at(-1)!;
      act(() => {
        ws.simulateOpen();
        ws.simulateServerClose();
      });
      // Advance past the LONGEST rung so a connection is made whatever the
      // delay was — the assertion is about how long it waited, not whether
      // it eventually retried.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
    }
  }

  it('backs off across accept-then-drop cycles instead of retrying every second', () => {
    const fetchSubmission = vi.fn(async () => undefined);
    connectThenDrop(3, fetchSubmission);

    // Four sockets: the first, plus one per drop. The fourth must have been
    // scheduled at the fourth rung of the ladder, not the first.
    expect(FakeWebSocket.instances).toHaveLength(4);
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.simulateOpen();
      ws.simulateServerClose();
    });
    // 1000 ms is the FIRST rung. If the backoff had been reset by `open`,
    // this would already have reconnected.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeWebSocket.instances).toHaveLength(4);
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(FakeWebSocket.instances).toHaveLength(5);
  });

  it('resets the backoff on the ack, which is what proves the connection worked', () => {
    const fetchSubmission = vi.fn(async () => undefined);
    connectThenDrop(3, fetchSubmission);

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.simulateOpen();
      // The gateway's proof that the subscription is live.
      ws.simulateMessage({ type: 'subscribed', id: 7 });
      ws.simulateServerClose();
    });
    // Back to the first rung: a connection that actually worked and then
    // dropped is a network blip, and must recover quickly.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeWebSocket.instances).toHaveLength(5);
  });
});

/**
 * D152 — a socket that never opens is silent.
 *
 * `onSubscriptionError` fires only on an explicit `error` FRAME, which means
 * the gateway accepted the upgrade and then refused the subscribe. A failed
 * upgrade — a proxy that does not carry `/ws`, a blocked port, a captive
 * portal — produces no frame of any kind, so the page sat on a blank verdict
 * panel forever while the judge was in fact grading the submission. Measured:
 * `vite preview` did exactly this for four e2e specs, which waited 60 s for a
 * badge on a submission the DB already had at `AC`.
 *
 * So a deadline: no `subscribed` ack within it and the hook says so and falls
 * back to polling the endpoint that already exists.
 */
describe('useSubmissionSocket — the fallback when the socket never opens', () => {
  it('declares itself degraded and polls when no ack arrives before the deadline', () => {
    const fetchSubmission = vi.fn(async () => undefined);
    const terminalRef = { current: false };
    const onDegraded = vi.fn();

    // The upgrade never completes: no 'open', no frames, nothing at all.
    renderHook(() => useSubmissionSocket(11, fetchSubmission, terminalRef, undefined, onDegraded));
    expect(onDegraded).not.toHaveBeenCalled();
    expect(fetchSubmission).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    // It says so — and it does not merely say so: the first poll is
    // immediate, because by now nothing at all has been fetched.
    expect(onDegraded).toHaveBeenCalledWith(true);
    expect(fetchSubmission).toHaveBeenCalledWith(11);

    const afterFirst = fetchSubmission.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(fetchSubmission.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('never fires the deadline while a proxy loops connect→close faster than it', () => {
    const fetchSubmission = vi.fn(async () => undefined);
    const terminalRef = { current: false };
    const onDegraded = vi.fn();
    renderHook(() => useSubmissionSocket(12, fetchSubmission, terminalRef, undefined, onDegraded));

    // ONE deadline per submission, armed when the effect first connects —
    // not restarted per connection attempt. A proxy that refuses upgrades
    // produces exactly this loop, each leg shorter than the deadline, and a
    // per-attempt timer would never fire in the case it exists for.
    for (let i = 0; i < 6; i += 1) {
      act(() => {
        FakeWebSocket.instances.at(-1)!.simulateServerClose();
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(onDegraded).toHaveBeenCalledWith(true);
  });

  it('stops polling and says it is live again when the ack finally arrives', () => {
    const fetchSubmission = vi.fn(async () => undefined);
    const terminalRef = { current: false };
    const onDegraded = vi.fn();
    renderHook(() => useSubmissionSocket(13, fetchSubmission, terminalRef, undefined, onDegraded));

    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(onDegraded).toHaveBeenLastCalledWith(true);

    // A later connection works. The ack is the one frame that proves it, the
    // same frame the backoff resets on.
    act(() => {
      const ws = FakeWebSocket.instances.at(-1)!;
      ws.simulateOpen();
      ws.simulateMessage({ type: 'subscribed', id: 13 });
    });
    expect(onDegraded).toHaveBeenLastCalledWith(false);

    const settled = fetchSubmission.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // Nothing but the socket now. A poll left running behind a working feed
    // is the load this fallback exists to avoid spending.
    expect(fetchSubmission.mock.calls.length).toBe(settled);
  });

  it('stops polling once the submission is terminal', () => {
    const fetchSubmission = vi.fn(async () => undefined);
    const terminalRef = { current: false };
    const onDegraded = vi.fn();
    renderHook(() => useSubmissionSocket(14, fetchSubmission, terminalRef, undefined, onDegraded));

    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(fetchSubmission).toHaveBeenCalled();

    // The poll reached the verdict — which is the whole point of it.
    terminalRef.current = true;
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    const settled = fetchSubmission.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchSubmission.mock.calls.length).toBe(settled);
  });

  it('leaves no timer behind when the effect is torn down mid-poll', () => {
    const fetchSubmission = vi.fn(async () => undefined);
    const terminalRef = { current: false };
    const { unmount } = renderHook(() =>
      useSubmissionSocket(15, fetchSubmission, terminalRef, undefined, vi.fn()),
    );
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(fetchSubmission).toHaveBeenCalled();

    unmount();
    const settled = fetchSubmission.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchSubmission.mock.calls.length).toBe(settled);
  });
});

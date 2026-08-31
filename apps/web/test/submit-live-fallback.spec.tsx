/**
 * D152 on the actual screen.
 *
 * `submission-socket.spec.tsx` proves the hook's timers. This proves the only
 * thing a pupil can perceive: that when the upgrade never completes — a proxy
 * that does not carry `/ws`, a blocked port, a captive portal — the page SAYS
 * so in Vietnamese and then finds the verdict anyway, instead of showing a
 * blank panel forever while the judge grades.
 *
 * The fake socket here never opens and never sends a frame. That is exactly
 * what a failed upgrade looks like from the browser: no error, no event, no
 * signal of any kind. Before this change, nothing in this file's flow ever
 * produced a single character of output.
 */
import type { ReactElement } from 'react';
import { EditorView } from '@codemirror/view';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const get = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => vi.fn(),
}));

const { SubmitPage } = await import('../src/routes/submit.js');

/** A socket that accepts `new WebSocket(...)` and then does nothing at all. */
class DeadWebSocket {
  static instances: DeadWebSocket[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    DeadWebSocket.instances.push(this);
  }
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

const GRADING = { id: 7, state: 'running', verdict: null, cases: [] };
const GRADED = {
  id: 7,
  state: 'done',
  verdict: 'AC',
  cases: [],
  points: 100,
  maxPoints: 100,
};

function submissionResponse(body: unknown) {
  return Promise.resolve({ data: body, error: undefined, response: { status: 200 } });
}

beforeEach(() => {
  DeadWebSocket.instances = [];
  vi.stubGlobal('WebSocket', DeadWebSocket);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  post.mockReset();
  get.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Types a solution into the editor and presses the button. */
async function submit(ui: ReactElement): Promise<void> {
  render(ui);
  const content = await screen.findByLabelText(/Mã nguồn/);
  const view = EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement)!;
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'int main(){}' } });
  });
  await act(async () => {
    screen.getByRole('button', { name: /Nộp bài/ }).click();
  });
}

describe('a verdict still arrives when the live channel never opens (D152)', () => {
  it('says updates are slow, polls, and shows the verdict it finds', async () => {
    post.mockResolvedValue({ data: { id: 7 }, error: undefined, response: { status: 201 } });
    get.mockImplementation(() => submissionResponse(GRADING));

    await submit(<SubmitPage problemCode="aplusb" />);

    // Nothing yet: the page is entitled to a few seconds of hoping.
    expect(screen.queryByText(/Đang cập nhật chậm/)).toBeNull();
    expect(get).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    // It says so — a standing fact, not an alert: nothing has failed and
    // there is nothing for the reader to do (D144's reasoning).
    const line = screen.getByText(/Đang cập nhật chậm/);
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveTextContent(/Không cần tải lại/);
    expect(get).toHaveBeenCalledWith('/submissions/{id}', { params: { path: { id: 7 } } });

    // And it keeps asking until it has an answer, which is the whole point.
    get.mockImplementation(() => submissionResponse(GRADED));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(screen.getByText('AC')).toBeInTheDocument();
    // The verdict is on the screen, so "updates are slow" now describes
    // nothing and goes away.
    expect(screen.queryByText(/Đang cập nhật chậm/)).toBeNull();
  });
});

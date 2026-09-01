import { EditorView } from '@codemirror/view';
/**
 * m23 — the submit page never said which contest it was submitting into.
 *
 * `contestKey` is what decides whether a `contest_submissions` row is written
 * at all (4d's explicit-key design), and it is threaded silently from the
 * router. A submission that quietly went to practice cannot be recovered: the
 * window closes and it never counted. This is the one screen where that choice
 * is actually made, so it has to say which one it made.
 */
import type { ReactElement } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const get = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: React.ReactNode; params?: { key?: string } }) => (
    <a href={`/contests/${params?.key ?? ''}`}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

const { SubmitPage } = await import('../src/routes/submit.js');

// `SubmitPage` reads the problem's per-language limits through TanStack
// Query now (F-39/D154), so it needs a client in scope. The query is
// deliberately not stubbed here: this file is about the contest banner and
// D80's cooldown, and an unanswered catalogue leaves the picker on its
// `cpp17` fallback — exactly the shape these tests were written against.
function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('SubmitPage', () => {
  it('names the contest it is submitting into, as a link', () => {
    wrap(<SubmitPage problemCode="aplusb" contestKey="spring" />);

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Nộp vào kỳ thi');
    expect(screen.getByRole('link', { name: 'spring' })).toHaveAttribute(
      'href',
      '/contests/spring',
    );
  });

  it('says plainly that a keyless submission is practice', () => {
    wrap(<SubmitPage problemCode="aplusb" />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/luyện tập/i)).toBeInTheDocument();
  });
});

/**
 * D80's refusal, on the one screen a contestant meets it.
 *
 * The API answers 429 `submission_rate_limited` with `Retry-After` in whole
 * seconds. Rendering the server's `detail` would put an English sentence with
 * no number in front of somebody mid-contest — and a cooldown with no number
 * is the message that gets pressed again in the same second, which is how a
 * limiter generates the load it exists to prevent.
 */
describe('SubmitPage on a 429', () => {
  afterEach(() => {
    post.mockReset();
    get.mockReset();
  });

  function refuse(retryAfter: string | null) {
    post.mockResolvedValue({
      error: { code: 'submission_rate_limited', detail: 'You are submitting too quickly.' },
      response: { status: 429, headers: new Headers(retryAfter === null ? {} : { 'Retry-After': retryAfter }) },
    });
  }

  async function attempt(): Promise<void> {
    wrap(<SubmitPage problemCode="aplusb" />);
    // The submit box is a lazily-loaded CodeMirror editor (D84): wait for it,
    // then write one transaction rather than "typing" into contenteditable,
    // which jsdom cannot drive.
    const content = await screen.findByLabelText(/Mã nguồn/);
    const view = EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement);
    if (!view) throw new Error('the editor did not mount');
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'int main(){}' } });
    });
    await userEvent.click(screen.getByRole('button', { name: /Nộp bài/ }));
  }

  it('says how long to wait, in the reader\'s language, and disables the button', async () => {
    refuse('7');
    await attempt();

    expect(await screen.findByRole('alert')).toHaveTextContent(/quá nhanh/);
    expect(screen.getByRole('alert')).toHaveTextContent('7');
    // The button, not just the words: pressing it again inside the window can
    // only be refused again.
    expect(screen.getByRole('button', { name: /Nộp bài/ })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/7 giây/);
  });

  it('still cools down when the header is missing, rather than inviting an instant retry', async () => {
    refuse(null);
    await attempt();

    expect(await screen.findByRole('alert')).toHaveTextContent(/quá nhanh/);
    expect(screen.getByRole('button', { name: /Nộp bài/ })).toBeDisabled();
  });

  it('leaves an ordinary refusal exactly as it was — the API detail, no cooldown', async () => {
    post.mockResolvedValue({
      error: { code: 'problem_not_submittable', detail: 'This problem has no published tests yet.' },
      response: { status: 409, headers: new Headers() },
    });
    await attempt();

    expect(await screen.findByRole('alert')).toHaveTextContent(/no published tests/);
    expect(screen.getByRole('button', { name: /Nộp bài/ })).not.toBeDisabled();
  });
});

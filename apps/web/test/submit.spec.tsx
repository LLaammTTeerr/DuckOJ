import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { SubmitForm, VerdictPanel, problemCodeFromSearch } from '../src/routes/submit.js';

const LANGUAGES = [{ key: 'cpp17', name: 'C++17', timeMs: 1000, memoryKb: 65536 }];

describe('SubmitForm', () => {
  it('submits the entered source and language', async () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <SubmitForm onSubmit={onSubmit} languages={LANGUAGES} busy={false} problemCode="aplusb" />,
    );

    // D84 replaced the <textarea> with CodeMirror, so there is no form
    // control to type into any more: the buffer is written through the
    // editor's own transaction, which is the code path a real keystroke
    // reaches once CodeMirror's DOM observer has read it. (The old note
    // here warned against `userEvent.type()`, whose `{...}` key-descriptor
    // DSL eats C++ braces — still true, and now moot.)
    const content = await screen.findByLabelText(/Mã nguồn/);
    const view = EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement)!;
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'int main(){}' } });
    });
    await userEvent.click(screen.getByRole('button', { name: /Nộp bài/ }));

    expect(onSubmit).toHaveBeenCalledWith({ languageKey: 'cpp17', source: 'int main(){}' });
  });

  it('disables the button while a submission is in flight', async () => {
    render(<SubmitForm onSubmit={vi.fn()} languages={LANGUAGES} busy problemCode="aplusb" />);
    // The NAME changes while it is busy (D148) — a button that still reads
    // "Nộp bài" and does nothing is indistinguishable, on a slow link, from a
    // page that ignored the click. Disabled is still the half that makes a
    // second press impossible.
    expect(await screen.findByRole('button', { name: /Đang nộp/ })).toBeDisabled();
  });
});

describe('VerdictPanel', () => {
  it('shows the running state before a verdict exists', () => {
    render(<VerdictPanel submission={{ state: 'compiling', verdict: null, cases: [] } as never} />);
    expect(screen.getByText(/Đang biên dịch/)).toBeInTheDocument();
  });

  /**
   * D160 — the one sentence a pupil whose language nothing can grade never
   * got. `blocked_reason` has existed on the job since D68 and, until this
   * slot, was read only by the admin dashboard.
   */
  it('says what a stuck queue is waiting for, and nothing about the fleet', () => {
    render(
      <VerdictPanel
        submission={
          {
            state: 'queued',
            languageKey: 'python3',
            verdict: null,
            cases: [],
            awaitingCapableJudge: true,
          } as never
        }
        languageName="Python 3"
      />,
    );
    // The LANGUAGE — the pupil's own choice — never the reason string, which
    // says how many judges are connected and what they can run.
    expect(screen.getByText(/máy chấm chạy được Python 3/)).toBeInTheDocument();
    expect(screen.queryByText(/no connected judge/)).not.toBeInTheDocument();
    // Still queued (D68): the job runs the instant a capable judge connects,
    // so the wait is explained rather than ended with a verdict nobody earned.
    expect(screen.getByText(/Đang xếp hàng/)).toBeInTheDocument();
  });

  it('stays quiet on an ordinary queued submission', () => {
    render(
      <VerdictPanel
        submission={
          {
            state: 'queued',
            languageKey: 'cpp17',
            verdict: null,
            cases: [],
            awaitingCapableJudge: false,
          } as never
        }
      />,
    );
    // A healthy queue is the common case, and a warning that fires on every
    // submission's first second is a warning nobody reads on the day it is
    // true.
    expect(screen.queryByText(/máy chấm chạy được/)).not.toBeInTheDocument();
  });

  it('shows the verdict and each case once grading finishes', () => {
    render(
      <VerdictPanel
        submission={
          {
            state: 'done',
            verdict: 'WA',
            points: 1,
            maxPoints: 3,
            cases: [
              {
                groupIndex: 0,
                caseIndex: 0,
                verdict: 'AC',
                skipped: false,
                timeMs: 4,
                memoryKb: 900,
              },
              {
                groupIndex: 0,
                caseIndex: 1,
                verdict: 'WA',
                skipped: false,
                timeMs: 5,
                memoryKb: 900,
              },
              { groupIndex: 0, caseIndex: 2, verdict: null, skipped: true, timeMs: 0, memoryKb: 0 },
            ],
          } as never
        }
      />,
    );

    expect(screen.getByText('WA', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    // A skipped case never ran, so it must not display a verdict of its own.
    expect(screen.getByText(/bỏ qua/)).toBeInTheDocument();
  });

  it('announces the state and verdict in a live region (WCAG 4.1.3)', () => {
    render(
      <VerdictPanel
        submission={{ state: 'done', verdict: 'AC', points: 3, maxPoints: 3, cases: [] } as never}
      />,
    );
    // The verdict arrives asynchronously (polled/streamed) after the reader
    // has stopped touching the page, so it must land in a live region or a
    // screen-reader user is never told the outcome. The dense case grid is
    // deliberately kept OUT of the region: re-announcing every cell on every
    // poll would be noise, not information.
    const live = screen.getByRole('status');
    expect(within(live).getByText('AC', { selector: 'strong' })).toBeInTheDocument();
    expect(within(live).queryByRole('list')).not.toBeInTheDocument();
  });
});

// Task 13 found this against the live stack: `routes/problem.tsx` links to
// `/submit?problem=<code>` for every problem, while this page's problem code
// was a hardcoded `aplusb` — so "Submit a solution" on any other problem
// submitted against the wrong one, and the API happily accepted it.
describe('problemCodeFromSearch', () => {
  it('submits against the problem the problem page linked with', () => {
    expect(problemCodeFromSearch('?problem=hello')).toBe('hello');
  });

  it('falls back to aplusb when no problem is named', () => {
    expect(problemCodeFromSearch('')).toBe('aplusb');
  });
});

// Also Task 13: `EventWriter` has written `verdict: 'CE'` for a compile error
// since Phase 2b Task 9, but this panel still keyed its "Compile error"
// wording off the pre-Task-9 `state === 'done' && verdict === 'IE'`, which a
// real compile error can no longer produce. No test covered the branch, so
// nothing failed when it became unreachable.
describe('VerdictPanel compile errors', () => {
  it('names a CE verdict a compile error rather than showing the raw code', () => {
    render(
      <VerdictPanel
        submission={
          {
            state: 'done',
            verdict: 'CE',
            points: 0,
            maxPoints: 0,
            compileOutput: 'error: expected ;',
            cases: [],
          } as never
        }
      />,
    );
    expect(screen.getByText(/Lỗi biên dịch/)).toBeInTheDocument();
    expect(screen.getByText(/expected ;/)).toBeInTheDocument();
  });

  it('leaves a genuine internal error labelled IE, not a compile error', () => {
    render(
      <VerdictPanel
        submission={
          { state: 'errored', verdict: 'IE', compileOutput: 'judge exploded', cases: [] } as never
        }
      />,
    );
    expect(screen.getByText('IE', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByText(/Lỗi biên dịch/)).not.toBeInTheDocument();
  });
});

/**
 * D148 and D84 on the box the whole judge exists for.
 */
describe('SubmitForm — the button tells the truth', () => {
  function editorWith(source: string): void {
    const content = screen.getByLabelText(/Mã nguồn/);
    const view = EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement)!;
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
    });
  }

  it('cannot be submitted twice in one tick', async () => {
    // `busy` is the PARENT's state: it becomes true only after `onSubmit`
    // has been awaited and a render has gone round, so two presses inside
    // one tick both saw `blocked === false` and both sent a submission.
    // On contest day that is two rows on the board and D80's rate limit
    // answering the second one.
    const onSubmit = vi.fn(() => new Promise<boolean>(() => undefined));
    render(
      <SubmitForm onSubmit={onSubmit} languages={LANGUAGES} busy={false} problemCode="aplusb" />,
    );
    await screen.findByLabelText(/Mã nguồn/);
    editorWith('int main(){}');

    const button = screen.getByRole('button', { name: /Nộp bài/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('says it is submitting, not just going grey', async () => {
    render(<SubmitForm onSubmit={vi.fn()} languages={LANGUAGES} busy problemCode="aplusb" />);
    const button = await screen.findByRole('button', { name: /Đang nộp/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('refuses a file too big to be a solution instead of freezing the tab', async () => {
    render(
      <SubmitForm onSubmit={vi.fn()} languages={LANGUAGES} busy={false} problemCode="aplusb" />,
    );
    await screen.findByLabelText(/Mã nguồn/);
    const picker = screen.getByLabelText(/Mở tệp/) as HTMLInputElement;
    // A pupil picks the wrong thing — a video, a dataset. `file.text()` on it
    // decodes the whole blob into a string before anything can measure it.
    const huge = new File(['x'.repeat(300_000)], 'wrong.cpp', { type: 'text/plain' });
    await userEvent.upload(picker, huge);

    expect(await screen.findByRole('alert')).toHaveTextContent(/quá lớn|too large/i);
    // and the buffer they were working in is untouched
    const content = screen.getByLabelText(/Mã nguồn/);
    const view = EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement)!;
    expect(view.state.doc.length).toBeLessThan(1000);
  });

  it('names the Ctrl/Cmd+Enter shortcut where the editor is, not in a help page', async () => {
    render(
      <SubmitForm onSubmit={vi.fn()} languages={LANGUAGES} busy={false} problemCode="aplusb" />,
    );
    expect(await screen.findByText(/Ctrl\/Cmd \+ Enter/)).toBeInTheDocument();
  });
});

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { SubmitForm, VerdictPanel, problemCodeFromSearch } from '../src/routes/submit.js';

describe('SubmitForm', () => {
  it('submits the entered source and language', async () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <SubmitForm onSubmit={onSubmit} languages={['cpp17']} busy={false} problemCode="aplusb" />,
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
    render(<SubmitForm onSubmit={vi.fn()} languages={['cpp17']} busy problemCode="aplusb" />);
    expect(await screen.findByRole('button', { name: /Nộp bài/ })).toBeDisabled();
  });
});

describe('VerdictPanel', () => {
  it('shows the running state before a verdict exists', () => {
    render(<VerdictPanel submission={{ state: 'compiling', verdict: null, cases: [] } as never} />);
    expect(screen.getByText(/Đang biên dịch/)).toBeInTheDocument();
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
              { groupIndex: 0, caseIndex: 0, verdict: 'AC', skipped: false, timeMs: 4, memoryKb: 900 },
              { groupIndex: 0, caseIndex: 1, verdict: 'WA', skipped: false, timeMs: 5, memoryKb: 900 },
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
          { state: 'done', verdict: 'CE', points: 0, maxPoints: 0, compileOutput: 'error: expected ;', cases: [] } as never
        }
      />,
    );
    expect(screen.getByText(/Lỗi biên dịch/)).toBeInTheDocument();
    expect(screen.getByText(/expected ;/)).toBeInTheDocument();
  });

  it('leaves a genuine internal error labelled IE, not a compile error', () => {
    render(
      <VerdictPanel
        submission={{ state: 'errored', verdict: 'IE', compileOutput: 'judge exploded', cases: [] } as never}
      />,
    );
    expect(screen.getByText('IE', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByText(/Lỗi biên dịch/)).not.toBeInTheDocument();
  });
});

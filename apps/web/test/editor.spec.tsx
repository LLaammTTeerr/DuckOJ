/**
 * The submit editor (D84): drafts, templates, the size gate, the keyboard
 * and the file picker.
 *
 * The editor is driven through its own `EditorView` rather than by typing
 * into `.cm-content` with `userEvent`. That is not a shortcut — jsdom does
 * no layout, and CodeMirror's DOM observer reconciles a contenteditable
 * against measurements that are all zero here, so synthesised keystrokes
 * land unreliably. A dispatched transaction is the SAME code path a real
 * keystroke takes once the observer has read it: `updateListener` fires, the
 * form's `onChange` runs, and everything under test happens downstream of
 * that.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { DRAFT_DEBOUNCE_MS, DRAFT_PREFIX, draftKey } from '../src/editor/drafts.js';
import { modeForLanguage, templateForLanguage } from '../src/editor/languages.js';
import { MAX_SOURCE_CHARS, SubmitForm, type SubmitValues } from '../src/routes/submit.js';

// Three languages, because the D84 draft path this file exercises is keyed
// per (problem, language) and only has anything to say when there is more
// than one to switch between. The limits differ per row exactly as the
// server's do (D154), so a switch that failed to re-read them would show.
const LANGUAGES = [
  { key: 'cpp17', name: 'C++17', timeMs: 1000, memoryKb: 65536 },
  { key: 'python3', name: 'Python 3', timeMs: 3000, memoryKb: 98304 },
  { key: 'java17', name: 'Java 17', timeMs: 2000, memoryKb: 131072 },
];
const PROBLEM = 'aplusb';
const CPP_DRAFT = draftKey(PROBLEM, 'cpp17');

afterEach(() => {
  vi.useRealTimers();
  // Only the drafts — `test/setup.ts` seeds the locale into the same store.
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(DRAFT_PREFIX)) localStorage.removeItem(key);
  }
});

async function mount(onSubmit: (v: SubmitValues) => Promise<boolean> | boolean, busy = false) {
  const spy = vi.fn(onSubmit);
  render(<SubmitForm onSubmit={spy} languages={LANGUAGES} busy={busy} problemCode={PROBLEM} />);
  const content = await screen.findByLabelText(/Mã nguồn/);
  const view = EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement);
  if (!view) throw new Error('the editor did not mount');
  return { spy, content, view };
}

/** What a pupil typing into the editor amounts to, as one transaction. */
function typeInto(view: EditorView, text: string): void {
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
}

const accept = async () => true;

describe('starter templates', () => {
  it('fills an empty editor with the language starter', async () => {
    const { view } = await mount(accept);
    expect(view.state.doc.toString()).toBe(templateForLanguage('cpp17'));
    expect(view.state.doc.toString()).toContain('ios::sync_with_stdio(false)');
  });

  it('never overwrites a draft with a template', async () => {
    localStorage.setItem(CPP_DRAFT, 'int main(){return 1;}');
    const { view } = await mount(accept);

    expect(view.state.doc.toString()).toBe('int main(){return 1;}');
    expect(view.state.doc.toString()).not.toContain('#include');
    expect(screen.getByRole('status')).toHaveTextContent('Khôi phục bản nháp');
  });

  it('keeps the code when the language changes, and only fills an editor left empty', async () => {
    const { view } = await mount(accept);

    typeInto(view, 'int main(){}');
    await userEvent.selectOptions(screen.getByLabelText('Ngôn ngữ'), 'python3');
    expect(view.state.doc.toString()).toBe('int main(){}');

    typeInto(view, '');
    await userEvent.selectOptions(screen.getByLabelText('Ngôn ngữ'), 'java17');
    expect(view.state.doc.toString()).toContain('public class Main');
  });

  it('does not file its own starter as if the pupil had typed it', async () => {
    // The template reaches the buffer through `props.value`, so it comes
    // back out of CodeMirror's update listener looking exactly like a
    // keystroke. Filed as a draft, it makes the NEXT visit greet the pupil
    // with "Khôi phục bản nháp" over code they never wrote.
    const { view } = await mount(accept);
    typeInto(view, '');
    // Fake timers BEFORE the switch: the write this is hunting for is
    // scheduled by the switch itself, so a clock installed afterwards would
    // never see it and the test would pass against the bug.
    vi.useFakeTimers();
    act(() => {
      fireEvent.change(screen.getByLabelText('Ngôn ngữ'), { target: { value: 'python3' } });
    });
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 4);
    });

    expect(view.state.doc.toString()).toContain('import sys');
    expect(localStorage.getItem(draftKey(PROBLEM, 'python3'))).toBeNull();
  });
});

describe('drafts', () => {
  it('saves the buffer once the typing pauses, and not before', async () => {
    const { view } = await mount(accept);
    vi.useFakeTimers();

    typeInto(view, 'half a solution');
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1);
    });
    expect(localStorage.getItem(CPP_DRAFT)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(localStorage.getItem(CPP_DRAFT)).toBe('half a solution');
  });

  it('files the draft under the language it was written in', async () => {
    const { view } = await mount(accept);
    vi.useFakeTimers();

    typeInto(view, 'cpp text');
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    });
    vi.useRealTimers();
    await userEvent.selectOptions(screen.getByLabelText('Ngôn ngữ'), 'python3');
    vi.useFakeTimers();
    typeInto(view, 'python text');
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    });

    expect(localStorage.getItem(CPP_DRAFT)).toBe('cpp text');
    expect(localStorage.getItem(draftKey(PROBLEM, 'python3'))).toBe('python text');
  });

  it('clears the draft on a successful submit, and a save still pending cannot resurrect it', async () => {
    const { view } = await mount(accept);
    vi.useFakeTimers();

    typeInto(view, 'first');
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    });
    expect(localStorage.getItem(CPP_DRAFT)).toBe('first');

    // A second edit leaves a write scheduled at the moment of the submit —
    // the exact race a `useEffect` debounce loses.
    typeInto(view, 'second');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Nộp bài/ }));
    });
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 10);
    });

    expect(localStorage.getItem(CPP_DRAFT)).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the draft when the API refuses the submission', async () => {
    const { view, spy } = await mount(async () => false);
    vi.useFakeTimers();

    typeInto(view, 'rejected but precious');
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Nộp bài/ }));
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CPP_DRAFT)).toBe('rejected but precious');
  });
});

describe('the size gate', () => {
  it('counts the source against the contract limit and refuses to submit past it', async () => {
    const { view, spy } = await mount(accept);

    typeInto(view, 'x'.repeat(MAX_SOURCE_CHARS));
    expect(screen.getByRole('button', { name: /Nộp bài/ })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    typeInto(view, 'x'.repeat(MAX_SOURCE_CHARS + 1));
    expect(screen.getByRole('button', { name: /Nộp bài/ })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(String(MAX_SOURCE_CHARS));

    fireEvent.keyDown(view.contentDOM, { key: 'Enter', ctrlKey: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the keyboard and the file picker', () => {
  it('submits on Ctrl+Enter rather than inserting a blank line', async () => {
    const { view, spy } = await mount(accept);
    typeInto(view, 'int main(){}');

    await act(async () => {
      fireEvent.keyDown(view.contentDOM, { key: 'Enter', ctrlKey: true });
    });

    expect(spy).toHaveBeenCalledWith({ languageKey: 'cpp17', source: 'int main(){}' });
    // `defaultKeymap` binds Mod-Enter to `insertBlankLine`; if it had won,
    // the buffer would have grown a line.
    expect(view.state.doc.toString()).toBe('int main(){}');
  });

  it('fills the editor from a chosen file', async () => {
    const { view } = await mount(accept);

    await userEvent.upload(
      screen.getByLabelText('Mở tệp'),
      new File(['import sys\n'], 'solution.py', { type: 'text/plain' }),
    );

    expect(view.state.doc.toString()).toBe('import sys\n');
  });
});

/**
 * F-39. The picker had one option for two weeks, so the code paths that only
 * exist when there is a SECOND language — switching, and the per-(problem,
 * language) draft D84 keyed on it — had never actually run against real data.
 */
describe('the language picker, once there is more than one language', () => {
  it('offers each row by its NAME, and submits its key', async () => {
    const { view, spy } = await mount(accept);

    // The option a pupil reads is "Python 3"; the value the API receives is
    // `python3`. While `cpp17` was the only row those were indistinguishable.
    await userEvent.selectOptions(screen.getByLabelText('Ngôn ngữ'), 'python3');
    expect(screen.getByRole('option', { name: 'Python 3' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'C++17' })).toBeInTheDocument();

    typeInto(view, 'print(1)');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Nộp bài/ }));
    });
    expect(spy).toHaveBeenCalledWith({ languageKey: 'python3', source: 'print(1)' });
  });

  it("shows the selected language's OWN limits, and re-reads them on a switch", async () => {
    await mount(accept);

    // D154: the number on screen is the one the judge enforces. The fixture
    // gives cpp17 1000 ms / 65536 KB and python3 3000 ms / 98304 KB.
    expect(screen.getByText(/1 giây và 64 MB/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Ngôn ngữ'), 'python3');
    expect(screen.getByText(/3 giây và 96 MB/)).toBeInTheDocument();
    // The old number must be GONE, not merely joined by the new one: two
    // limits on screen at once is worse than either alone.
    expect(screen.queryByText(/1 giây và 64 MB/)).not.toBeInTheDocument();
  });

  it('describes the picker with those limits rather than shouting them', async () => {
    await mount(accept);
    // `aria-describedby`, not a second `role="status"` live region: this page
    // already has one (the restored-draft notice), and the limits are a
    // standing description of the chosen option rather than an event.
    const picker = screen.getByLabelText('Ngôn ngữ');
    expect(picker).toHaveAttribute('aria-describedby', 'language-limits');
  });

  it('gives each language back its own draft when the pupil switches back (D84)', async () => {
    const { view } = await mount(accept);
    vi.useFakeTimers();
    typeInto(view, 'int main(){}');
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    });
    vi.useRealTimers();

    // Away to Python, where the buffer keeps the C++ text (D84: a switch
    // never destroys work) — so the pupil clears it and writes Python.
    await userEvent.selectOptions(screen.getByLabelText('Ngôn ngữ'), 'python3');
    vi.useFakeTimers();
    typeInto(view, 'print(1)');
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    });
    vi.useRealTimers();

    expect(localStorage.getItem(draftKey(PROBLEM, 'cpp17'))).toBe('int main(){}');
    expect(localStorage.getItem(draftKey(PROBLEM, 'python3'))).toBe('print(1)');
  });
});

describe('modeForLanguage', () => {
  it('maps every seeded and plausible key, and falls back to plain text', () => {
    // Every key migration 0042 actually seeds (F-39). D84 chose a PREFIX
    // rule over a table so that a language added later highlights with no web
    // deploy — this is that promise being collected on, and `python3` in
    // particular was never one of the examples D84 listed.
    expect(modeForLanguage('cpp17')).toBe('cpp');
    expect(modeForLanguage('cpp20')).toBe('cpp');
    expect(modeForLanguage('cpp14')).toBe('cpp');
    expect(modeForLanguage('c11')).toBe('cpp');
    expect(modeForLanguage('python3')).toBe('python');
    expect(templateForLanguage('python3')).toContain('sys.stdin');
    expect(templateForLanguage('c11')).toContain('ios::sync_with_stdio');
    expect(modeForLanguage('py3')).toBe('python');
    expect(modeForLanguage('python311')).toBe('python');
    expect(modeForLanguage('java17')).toBe('java');
    // C# is not C++, and must not be highlighted as it.
    expect(modeForLanguage('csharp')).toBe('plain');
    expect(modeForLanguage('pascal')).toBe('plain');
    expect(templateForLanguage('pascal')).toBe('');
  });
});

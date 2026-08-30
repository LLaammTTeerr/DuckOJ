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

const LANGUAGES = ['cpp17', 'py3', 'java17'];
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
  render(
    <SubmitForm onSubmit={spy} languages={LANGUAGES} busy={busy} problemCode={PROBLEM} />,
  );
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
    await userEvent.selectOptions(screen.getByLabelText('Ngôn ngữ'), 'py3');
    expect(view.state.doc.toString()).toBe('int main(){}');

    typeInto(view, '');
    await userEvent.selectOptions(screen.getByLabelText('Ngôn ngữ'), 'java17');
    expect(view.state.doc.toString()).toContain('public class Main');
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
    await userEvent.selectOptions(screen.getByLabelText('Ngôn ngữ'), 'py3');
    vi.useFakeTimers();
    typeInto(view, 'python text');
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    });

    expect(localStorage.getItem(CPP_DRAFT)).toBe('cpp text');
    expect(localStorage.getItem(draftKey(PROBLEM, 'py3'))).toBe('python text');
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

describe('modeForLanguage', () => {
  it('maps every seeded and plausible key, and falls back to plain text', () => {
    expect(modeForLanguage('cpp17')).toBe('cpp');
    expect(modeForLanguage('cpp20')).toBe('cpp');
    expect(modeForLanguage('c11')).toBe('cpp');
    expect(modeForLanguage('py3')).toBe('python');
    expect(modeForLanguage('python311')).toBe('python');
    expect(modeForLanguage('java17')).toBe('java');
    // C# is not C++, and must not be highlighted as it.
    expect(modeForLanguage('csharp')).toBe('plain');
    expect(modeForLanguage('pascal')).toBe('plain');
    expect(templateForLanguage('pascal')).toBe('');
  });
});

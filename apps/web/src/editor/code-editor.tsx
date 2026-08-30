/**
 * The submit screen's code editor: CodeMirror 6, composed by hand.
 *
 * Deliberately NOT the `codemirror` meta-package's `basicSetup`, and not a
 * React wrapper such as `@uiw/react-codemirror`. `basicSetup` drags in
 * autocompletion, search, folding and lint — four panels a pupil pasting a
 * solution into a submit box never opens — and a wrapper adds a second
 * lifecycle to reason about on top of the one `EditorView` already has. The
 * six extensions below are the whole feature set the brief asks for.
 *
 * The view is created ONCE and destroyed in the effect's cleanup, which is
 * what makes it safe under <StrictMode>'s mount→unmount→remount (D3). Every
 * callback the view needs is read through a ref rather than captured, so a
 * new `onChange` identity does not tear the editor down and lose the
 * cursor mid-keystroke.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { classHighlighter } from '@lezer/highlight';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { java } from '@codemirror/lang-java';
import { modeForLanguage, type EditorMode } from './languages.js';

function grammarFor(mode: EditorMode): Extension {
  if (mode === 'cpp') return cpp();
  if (mode === 'python') return python();
  if (mode === 'java') return java();
  // Plain text: no grammar at all, rather than a wrong one.
  return [];
}

/**
 * Colour comes from `classHighlighter`, which emits stable `tok-*` class
 * names, and the hues live in `app.css` beside the verdict palette — D67's
 * split (tokens.css owns material, app.css owns meaning) applied to syntax.
 * A `HighlightStyle.define` here would put a second colour system in
 * JavaScript where `test/app-css.spec.ts` cannot see it.
 */
const SHARED_EXTENSIONS: Extension[] = [
  lineNumbers(),
  history(),
  bracketMatching(),
  highlightActiveLine(),
  syntaxHighlighting(classHighlighter),
  EditorState.allowMultipleSelections.of(true),
  // Four spaces, and Tab inserts them. CodeMirror's default binds Tab to
  // focus movement for accessibility; `indentWithTab` is the documented
  // opt-in, and Escape-then-Tab still leaves the editor, so the keyboard
  // trap that rule exists to prevent stays closed.
  indentUnit.of('    '),
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  EditorView.lineWrapping,
];

/**
 * The look. Every value is a token from `design/tokens.css`, so dark mode,
 * `prefers-reduced-transparency` and the solid twins of D67 all arrive for
 * free — there is no second palette to keep in step.
 */
const THEME = EditorView.theme({
  '&': {
    color: 'var(--fg)',
    backgroundColor: 'var(--glass-inset)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--r-sm)',
  },
  '&.cm-focused': { outline: '2px solid var(--fg)', outlineOffset: '1px' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--fg)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--faint)',
    border: 'none',
    borderRight: '1px solid var(--line)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--sel)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--dim)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--mark)',
    color: 'var(--mark-fg)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel)',
  },
});

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter. Returns nothing; the page decides what submitting means. */
  onSubmit: () => void;
  /** The API's language key — mapped to a grammar by `modeForLanguage`. */
  languageKey: string;
  /** Required: this control replaced a labelled `<textarea>` and must keep its name. */
  ariaLabel: string;
  fontSize: number;
  /**
   * Written onto the contenteditable so the visible `<label for>` and the
   * e2e suite's historical `#source` selector both still point at the
   * control they always did.
   */
  id?: string;
}

export default function CodeEditor(props: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Everything the view's own callbacks read, kept current without ever
  // re-creating the view.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onSubmitRef = useRef(props.onSubmit);
  onSubmitRef.current = props.onSubmit;

  const language = useMemo(() => new Compartment(), []);
  const appearance = useMemo(() => new Compartment(), []);
  const initial = useRef(props.value);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          // `Prec.highest` is load-bearing, not defensive: `defaultKeymap`
          // already binds Mod-Enter to `insertBlankLine`, so without this
          // the shortcut a pupil is told to press would quietly insert a
          // line instead of submitting.
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  onSubmitRef.current();
                  return true;
                },
              },
            ]),
          ),
          ...SHARED_EXTENSIONS,
          THEME,
          language.of([]),
          appearance.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [language, appearance]);

  // The grammar follows the <select>, through a compartment: reconfiguring
  // costs no document, no history and no cursor, which recreating the view
  // would.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: language.reconfigure(grammarFor(modeForLanguage(props.languageKey))),
    });
  }, [language, props.languageKey]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: appearance.reconfigure([
        // Only the size lives here. The scroller's HEIGHT is app.css's
        // (`.editor-host`), so the phone's 40vh is a media query a reviewer
        // can read in the stylesheet rather than a number buried in JS.
        EditorView.theme({ '&': { fontSize: `${props.fontSize}px` } }),
        EditorView.contentAttributes.of({
          'aria-label': props.ariaLabel,
          ...(props.id ? { id: props.id } : {}),
        }),
      ]),
    });
  }, [appearance, props.fontSize, props.ariaLabel, props.id]);

  // The buffer is owned by the page (a template insertion, a restored draft
  // and a file upload all write it from outside), so an external change is
  // pushed in — but only when it actually differs, or every keystroke would
  // round-trip through a redundant transaction and collapse the selection.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === props.value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  return <div className="editor-host" ref={hostRef} />;
}

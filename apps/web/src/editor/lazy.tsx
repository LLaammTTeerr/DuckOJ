/**
 * The code-split boundary. CodeMirror plus three grammars is ~300 KB of
 * JavaScript that nobody reading a problem statement, a scoreboard or their
 * own submission list needs; behind `React.lazy` it becomes a chunk fetched
 * the first time a submit form is rendered, and the entry bundle every other
 * screen pays for is unchanged.
 *
 * The static `import()` lives here and NOWHERE else — a single ordinary
 * `import` of `./code-editor.js` from any eagerly-loaded module would pull
 * the whole thing straight back into the main chunk, silently.
 */
import { Suspense, lazy } from 'react';
import type { CodeEditorProps } from './code-editor.js';

const CodeEditor = lazy(() => import('./code-editor.js'));

/**
 * The fallback is a box of the editor's own size, not a spinner: the form
 * around it must not jump when the chunk lands.
 */
export function LazyCodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<div className="editor-host editor-pending" aria-hidden="true" />}>
      <CodeEditor {...props} />
    </Suspense>
  );
}

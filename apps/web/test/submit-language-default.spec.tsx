/**
 * D158 — which language the submit picker starts on, and whether that answer
 * is the same one twice.
 *
 * `SubmitPage` reads `GET /problems/{code}` through TanStack Query under the
 * key `['problem', code]` — **the same key the statement page uses**. So the
 * page has two different first renders:
 *
 *  * cold (a direct link to `/submit`): `limits.data` is undefined, the form
 *    mounts against `FALLBACK_LANGUAGES`, and `useState(firstLanguage)` locks
 *    in `cpp17`;
 *  * warm (the ordinary path — read the statement, press Submit): the cache
 *    answers synchronously, so the form mounts against the real catalogue and
 *    locks in whatever the API happened to put first.
 *
 * The API ordered that array by KEY, so the warm first render preselected
 * `c11`. A pupil who read the statement and pressed Submit got C11 with the
 * C starter template; the same pupil arriving by link got C++17. Paste a C++
 * program into the first of those and the verdict is a Compile Error, on
 * contest day, for a correct program.
 *
 * Two properties, both asserted here:
 *  1. the default does not depend on whether the cache was warm, and
 *  2. the default is always a language actually on offer — which the second
 *     describe covers, because a problem that refuses `cpp17` used to leave
 *     the state pointing at a language the picker no longer listed and the
 *     API answers 404 to.
 */
import type { ReactElement } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { DRAFT_DEBOUNCE_MS, DRAFT_PREFIX, draftKey } from '../src/editor/drafts.js';

const post = vi.fn();
const get = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
}));

const { SubmitPage } = await import('../src/routes/submit.js');

/** What the live stack returns for `aplusb`, ordered as the API orders it. */
function detail(keys: readonly string[]) {
  const names: Record<string, string> = {
    c11: 'C11',
    cpp14: 'C++14',
    cpp17: 'C++17',
    cpp20: 'C++20',
    python3: 'Python 3',
  };
  return {
    code: 'aplusb',
    languageLimits: keys.map((key) => ({
      languageKey: key,
      languageName: names[key] ?? key,
      timeMs: key === 'python3' ? 3000 : 1000,
      memoryKb: key === 'python3' ? 98304 : 65536,
      allowed: true,
    })),
  };
}

function clientWith(cached?: unknown): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached !== undefined) client.setQueryData(['problem', 'aplusb'], cached);
  return client;
}

function wrap(ui: ReactElement, client: QueryClient) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * The picker, by id rather than by label: this file asserts a value, not a
 * translation, and the locale a bare `render` resolves is not this test's
 * subject.
 */
function picker(): HTMLSelectElement {
  return document.getElementById('language') as HTMLSelectElement;
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  // Only the drafts: `test/setup.ts` seeds the locale into the same store,
  // and clearing it outright renders this file's Vietnamese assertions in
  // whatever the fallback happens to be.
  for (const key of Object.keys(globalThis.localStorage)) {
    if (key.startsWith(DRAFT_PREFIX)) globalThis.localStorage.removeItem(key);
  }
});

describe('the language the submit picker starts on', () => {
  it('is the same whether the pupil arrived by link or from the statement page', async () => {
    // The catalogue exactly as the API sends it. WHICH key comes first is the
    // server's decision and is pinned by `apps/api/test/problem-language-limits.spec.ts`;
    // what this test says is that the picker gives the same answer twice.
    const server = detail(['c11', 'cpp14', 'cpp17', 'cpp20', 'python3']);
    get.mockResolvedValue({ data: server, error: undefined, response: new Response() });

    // Cold: nothing cached, so the form mounts against `FALLBACK_LANGUAGES`
    // and the catalogue arrives a tick later.
    const cold = wrap(<SubmitPage problemCode="aplusb" />, clientWith());
    await waitFor(() => {
      expect(picker().options.length).toBe(5);
    });
    const coldDefault = picker().value;
    cold.unmount();

    // Warm: the statement page has already filled `['problem', 'aplusb']`,
    // so the very first render sees the real catalogue.
    wrap(<SubmitPage problemCode="aplusb" />, clientWith(server));
    await waitFor(() => {
      expect(picker().options.length).toBe(5);
    });
    const warmDefault = picker().value;

    expect(warmDefault).toBe(coldDefault);
    // And it is one of the languages on offer, in both cases.
    expect(server.languageLimits.map((l) => l.languageKey)).toContain(coldDefault);
  });

  it('is always a language the picker actually lists', async () => {
    // A problem that refuses C++17 (D154's `allowed = false`). Cold, the form
    // locks in the `cpp17` fallback and never revisits it — so the picker
    // LISTS Python and the button POSTS C++17, which the API answers 404
    // `language_not_found` to. The screen and the request disagree, and only
    // the request is asked.
    const server = detail(['python3']);
    get.mockResolvedValue({ data: server, error: undefined, response: new Response() });
    post.mockResolvedValue({ data: { id: 1 }, error: undefined, response: new Response() });

    wrap(<SubmitPage problemCode="aplusb" />, clientWith());
    await waitFor(() => {
      expect([...picker().options].map((option) => option.value)).toEqual(['python3']);
    });

    await userEvent.click(document.querySelector('form button[type="submit"]')!);
    await waitFor(() => {
      expect(post).toHaveBeenCalled();
    });
    expect((post.mock.calls[0]![1] as { body: { languageKey: string } }).body.languageKey).toBe(
      'python3',
    );
  });
});

/**
 * The residual B-30 recorded and F-41 could not close: the mount path that
 * CORRECTS an unofferable default loses the draft waiting in the language it
 * corrected to, and then files the carried-over buffer over it.
 *
 * D158's fix derives the language key from what the server offers, so on a
 * problem whose `allowed = false` kills the fallback language the key flips
 * at MOUNT — the catalogue arrives a tick after the first render — without
 * ever passing through `changeLanguage`, which is where B-30 put the restore.
 * The opening buffer was decided once, in a `useRef`, against the FALLBACK
 * language, and nothing ever revisited it.
 *
 * It became reachable for the first time in F-41, which gave setters a form
 * that writes `allowed = false` without SQL. The pupil lands on the one
 * language the problem still accepts, is shown a C++ starter template they
 * never asked for, and their half-written Python program is both invisible
 * and one keystroke from being overwritten.
 */
describe('the catalogue arriving late and correcting the default (D84 on the mount path)', () => {
  /** The lazily-loaded CodeMirror instance, once it is on screen. */
  async function editorView(): Promise<EditorView> {
    const content = await screen.findByLabelText(/Mã nguồn/);
    const view = EditorView.findFromDOM(content.closest('.cm-editor') as HTMLElement);
    if (!view) throw new Error('the editor did not mount');
    return view;
  }

  it('gives back the draft waiting in the language it corrected TO', async () => {
    localStorage.setItem(draftKey('aplusb', 'python3'), 'print(41)  # unfinished');
    // A problem that refuses every C++ dialect: the cold mount's fallback
    // (`cpp17`) is not on offer, so the derived key flips to `python3`.
    const server = detail(['python3']);
    get.mockResolvedValue({ data: server, error: undefined, response: new Response() });

    wrap(<SubmitPage problemCode="aplusb" />, clientWith());
    await waitFor(() => {
      expect(picker().value).toBe('python3');
    });

    const view = await editorView();
    await waitFor(() => {
      expect(view.state.doc.toString()).toBe('print(41)  # unfinished');
    });
    // And the pupil is TOLD, rather than finding code they do not remember
    // writing (D84's own rule, which `editor.spec.tsx` pins for the ordinary
    // mount).
    expect(screen.getByRole('status')).toHaveTextContent('Khôi phục bản nháp');
  });

  it('does not file the carried-over buffer over that draft', async () => {
    const pythonKey = draftKey('aplusb', 'python3');
    localStorage.setItem(pythonKey, 'print(41)  # unfinished');
    const server = detail(['python3']);
    get.mockResolvedValue({ data: server, error: undefined, response: new Response() });

    wrap(<SubmitPage problemCode="aplusb" />, clientWith());
    await waitFor(() => {
      expect(picker().value).toBe('python3');
    });
    const view = await editorView();

    // One keystroke, and the debounce allowed to land. This is the data loss:
    // against the bug the buffer still holds the C++ starter template, and
    // this write files it under the PYTHON key, on top of the program the
    // pupil came back for.
    vi.useFakeTimers();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n' } });
    });
    act(() => {
      vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2);
    });
    vi.useRealTimers();

    expect(localStorage.getItem(pythonKey)).toContain('print(41)');
    expect(localStorage.getItem(pythonKey)).not.toContain('#include');
  });
});

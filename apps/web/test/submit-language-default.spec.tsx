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
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  globalThis.localStorage.clear();
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

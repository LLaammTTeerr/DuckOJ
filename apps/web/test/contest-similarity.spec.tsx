/**
 * The organiser's "Kiểm tra trùng lặp" section, and the side-by-side view
 * behind it (D77).
 *
 * Four claims: only an organiser is offered it, the caution is on the screen
 * and not in a footnote, the run button posts the threshold that is actually
 * in the box, and the comparison marks the matched regions of both sources
 * rather than rendering them as markup.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    PATCH: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { ContestPage, SimilarityPairPage, markedSegments } = await import(
  '../src/routes/contests.js'
);

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const FINISHED_CONTEST = {
  key: 'spring',
  name: 'Spring',
  format: 'icpc',
  startTime: '2020-01-01T00:00:00.000Z',
  endTime: '2020-01-01T05:00:00.000Z',
  pointsPrecision: 3,
  canEdit: true,
  orgs: [],
  problems: [{ code: 'aplusb', name: 'A+B', label: 'A', points: 100, partial: true, order: 0 }],
};

const PAIR = {
  problemCode: 'aplusb',
  problemLabel: 'A',
  a: 'an',
  b: 'binh',
  aSubmissionId: 11,
  bSubmissionId: 12,
  jaccard: 0.71,
  containment: 0.93,
  language: 'cpp',
};

function run(over: Record<string, unknown> = {}) {
  return {
    id: 3,
    status: 'finished',
    threshold: 0.6,
    startedAt: '2026-08-30T02:00:00.000Z',
    finishedAt: '2026-08-30T02:00:05.000Z',
    requestedBy: 'boss',
    error: null,
    participants: 12,
    problems: [
      { code: 'aplusb', label: 'A', participants: 12, compared: 66, reported: 1, truncated: false },
    ],
    pairs: [PAIR],
    ...over,
  };
}

function routeGet(opts: { canEdit?: boolean; run?: unknown } = {}): void {
  get.mockImplementation((path: string) => {
    if (path === '/contests/{key}') {
      return Promise.resolve({
        data: { ...FINISHED_CONTEST, canEdit: opts.canEdit !== false },
      });
    }
    if (path === '/contests/{key}/me') return Promise.resolve({ data: undefined });
    if (path === '/contests/{key}/clarifications') {
      return Promise.resolve({ data: { items: [], truncated: false } });
    }
    if (path === '/contests/{key}/similarity') {
      return Promise.resolve({ data: { run: opts.run === undefined ? run() : opts.run } });
    }
    return Promise.resolve({ data: { username: 'boss', globalRole: 'user' } });
  });
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
});

describe('the duplicate-source section', () => {
  it('is offered to an organiser, with the caution beside it', async () => {
    routeGet();
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('heading', { name: /Kiểm tra trùng lặp/ })).toBeTruthy();
    // D77's whole ruling, on the screen: a score is a reason to look.
    expect(screen.getByText(/không phải là kết luận/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Chạy kiểm tra/ })).toBeTruthy();
  });

  it('is not offered to anybody who does not run the contest', async () => {
    routeGet({ canEdit: false });
    wrap(<ContestPage contestKey="spring" />);
    // Wait for the page itself before asserting an absence, or the assertion
    // passes on an unrendered page.
    await screen.findByRole('heading', { name: 'Spring' });
    expect(screen.queryByRole('heading', { name: /Kiểm tra trùng lặp/ })).toBeNull();
    // And it never even asks — an organiser-only route is not requested by a
    // page that has no organiser on it.
    expect(get.mock.calls.map((call) => call[0])).not.toContain('/contests/{key}/similarity');
  });

  it('lists a reported pair with both scores', async () => {
    routeGet();
    wrap(<ContestPage contestKey="spring" />);
    // Awaited on the DATA, not on the heading: the section renders
    // synchronously and the report arrives a tick later.
    expect(await screen.findByText('93%')).toBeTruthy();
    expect(screen.getByText('71%')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'an' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'binh' })).toBeTruthy();
  });

  it('posts the threshold that is actually in the box', async () => {
    routeGet({ run: null });
    post.mockResolvedValue({ data: run({ status: 'running' }) });
    wrap(<ContestPage contestKey="spring" />);
    const box = await screen.findByLabelText(/Ngưỡng/);
    await userEvent.clear(box);
    await userEvent.type(box, '0.85');
    await userEvent.click(screen.getByRole('button', { name: /Chạy kiểm tra/ }));
    await waitFor(() => {
      expect(post).toHaveBeenCalled();
    });
    // A number, not the string the input holds: the contract's `threshold`
    // is a number and a `"0.85"` would fail validation at the server.
    expect(post.mock.calls[0]?.[1]).toMatchObject({ body: { threshold: 0.85 } });
  });

  it('says so, and disables the button, while a run is going', async () => {
    routeGet({ run: run({ status: 'running', finishedAt: null, pairs: [], problems: [] }) });
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('status')).toHaveTextContent(/Đang kiểm tra/);
    expect(screen.getByRole('button', { name: /Chạy kiểm tra/ })).toBeDisabled();
  });

  it('tells an organiser when a problem’s pairs were truncated', async () => {
    routeGet({
      run: run({
        problems: [
          { code: 'aplusb', label: 'A', participants: 40, compared: 780, reported: 900, truncated: true },
        ],
      }),
    });
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('status')).toHaveTextContent(/vượt quá sức chứa/);
  });

  it('says a contest has never been checked rather than showing an empty table', async () => {
    routeGet({ run: null });
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByText(/chưa được kiểm tra lần nào/)).toBeTruthy();
  });
});

describe('markedSegments', () => {
  it('splits a source into plain and matched runs', () => {
    expect(markedSegments('abcdef', [{ start: 2, end: 4 }])).toEqual([
      { text: 'ab', matched: false },
      { text: 'cd', matched: true },
      { text: 'ef', matched: false },
    ]);
  });

  it('reassembles into exactly the original source, every time', () => {
    const source = 'int main() { return 0; }';
    for (const spans of [
      [],
      [{ start: 0, end: source.length }],
      [{ start: 0, end: 3 }, { start: 4, end: 8 }],
    ]) {
      expect(markedSegments(source, spans).map((s) => s.text).join('')).toBe(source);
    }
  });

  it('survives a span the server and this string disagree about', () => {
    // Truncating the source rather than dropping a bad highlight would hide
    // code from the person whose whole job here is to read it.
    const source = 'abc';
    expect(markedSegments(source, [{ start: 1, end: 99 }]).map((s) => s.text).join('')).toBe(source);
    expect(markedSegments(source, [{ start: -5, end: 2 }]).map((s) => s.text).join('')).toBe(source);
    // Out of order and overlapping — the server sends them sorted and merged,
    // and an unclamped walk over these emits 'abcabc': the code DUPLICATED,
    // which on this screen is an accusation about text nobody wrote.
    expect(
      markedSegments(source, [{ start: 2, end: 3 }, { start: 0, end: 1 }])
        .map((s) => s.text)
        .join(''),
    ).toBe(source);
  });
});

describe('the side-by-side view', () => {
  const VIEW = {
    problemCode: 'aplusb',
    problemLabel: 'A',
    jaccard: 0.71,
    containment: 0.93,
    a: {
      username: 'an',
      submissionId: 11,
      languageKey: 'cpp17',
      source: 'int main() { return 0; }',
      spans: [{ start: 0, end: 10 }],
    },
    b: {
      username: 'binh',
      submissionId: 12,
      languageKey: 'cpp20',
      source: 'int main() { return 1; }',
      spans: [{ start: 0, end: 10 }],
    },
  };

  it('marks the matched region of both sources', async () => {
    get.mockResolvedValue({ data: VIEW });
    const { container } = wrap(<SimilarityPairPage contestKey="spring" a="an" b="binh" problem="aplusb" />);
    await screen.findByRole('link', { name: 'an' });
    const marks = container.querySelectorAll('mark.match');
    expect(marks).toHaveLength(2);
    expect(marks[0]?.textContent).toBe('int main()');
    // Both programs are on the screen in full, not just the matched part.
    expect(container.textContent).toContain('return 0;');
    expect(container.textContent).toContain('return 1;');
  });

  it('renders a source as TEXT, never as markup', async () => {
    get.mockResolvedValue({
      data: {
        ...VIEW,
        a: { ...VIEW.a, source: '<img src=x onerror="alert(1)">', spans: [] },
      },
    });
    const { container } = wrap(<SimilarityPairPage contestKey="spring" a="an" b="binh" />);
    await screen.findByRole('link', { name: 'an' });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('reports a pair the run never found rather than showing something else', async () => {
    get.mockResolvedValue({ error: { code: 'similarity_pair_not_found', detail: 'Không có cặp đó.' } });
    wrap(<SimilarityPairPage contestKey="spring" a="an" b="cuong" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không có cặp đó/);
  });
});

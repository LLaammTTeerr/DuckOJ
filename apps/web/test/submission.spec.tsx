/**
 * `/submissions/$id` — the page whose absence made every old submission a
 * dead end. Rendering rides the same `VerdictPanel` the live submit screen
 * uses, so only this page's own obligations are pinned here: the metadata
 * links out, the source is shown verbatim, and a 404 stays an error.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({ api: { GET: (...a: unknown[]) => get(...a) } }));
// The `to`/`params` pair is resolved into a real href rather than dropped on
// the floor: the contest link below is only worth anything if it points at
// the right contest, and a stub that renders `#` for every link cannot say so.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
  }) => {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to ?? '#',
    );
    return <a href={href}>{children}</a>;
  },
}));

const { SubmissionPage } = await import('../src/routes/submission.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const DETAIL = {
  id: 42,
  problemCode: 'aplusb',
  username: 'alice',
  teamName: null,
  languageKey: 'cpp17',
  source: 'int main() { return 0; }',
  state: 'done',
  verdict: 'AC',
  points: 100,
  maxPoints: 100,
  timeMs: 12,
  memoryKb: 1024,
  compileOutput: null,
  cases: [
    { groupIndex: 0, caseIndex: 1, verdict: 'AC', skipped: false, timeMs: 12, memoryKb: 1024, points: 100, maxPoints: 100, feedback: null },
  ],
  contestKey: null,
  contestLabel: null,
  createdAt: '2026-08-01T00:00:00Z',
  judgedAt: '2026-08-01T00:00:05Z',
};

afterEach(() => {
  get.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SubmissionPage', () => {
  it('shows verdict, cases and the source verbatim', async () => {
    get.mockResolvedValue({ data: DETAIL });
    wrap(<SubmissionPage id={42} />);

    expect(await screen.findByRole('heading', { name: /Bài nộp #42/ })).toBeInTheDocument();
    expect(screen.getByText('AC')).toHaveClass('badge', 'ac');
    expect(screen.getByText('int main() { return 0; }')).toBeInTheDocument();
    // The problem is a link out, not a label.
    expect(screen.getByRole('link', { name: 'aplusb' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/submissions/{id}', { params: { path: { id: 42 } } });
  });

  it('links a contest submission to its contest, by name', async () => {
    get.mockResolvedValue({
      data: { ...DETAIL, contestKey: 'spring-2026', contestLabel: 'Spring Cup 2026' },
    });
    wrap(<SubmissionPage id={42} />);

    // Which contest an attempt belongs to is the fact this page could not
    // previously state: a contest submission and a practice one to the same
    // problem rendered identically.
    const link = await screen.findByRole('link', { name: 'Spring Cup 2026' });
    expect(link).toHaveAttribute('href', '/contests/spring-2026');
  });

  it('names the submitter, and the team on a team submission (D117)', async () => {
    get.mockResolvedValue({ data: { ...DETAIL, username: 'bob', teamName: 'Đội Rồng' } });
    wrap(<SubmissionPage id={42} />);

    // A teammate may open the team's submission, so the page says who made it.
    const who = await screen.findByRole('link', { name: 'bob' });
    expect(who).toHaveAttribute('href', '/users/bob');
    // The team label rides beside the submitter — one team, one entity.
    expect(who.closest('p')).toHaveTextContent(/đội Đội Rồng/);
  });

  it('shows no team label for an individual or practice submission', async () => {
    get.mockResolvedValue({ data: DETAIL });
    wrap(<SubmissionPage id={42} />);
    await screen.findByRole('heading', { name: /Bài nộp #42/ });
    expect(screen.queryByText(/đội /)).toBeNull();
  });

  it('says nothing about a contest for a practice submission', async () => {
    get.mockResolvedValue({ data: DETAIL });
    wrap(<SubmissionPage id={42} />);
    await screen.findByRole('heading', { name: /Bài nộp #42/ });
    expect(screen.queryByText(/Kỳ thi/)).toBeNull();
  });

  it('a submission the caller may not see stays an error, not a blank page', async () => {
    get.mockResolvedValue({ data: undefined, error: { detail: 'No such submission.' } });
    wrap(<SubmissionPage id={7} />);
    // The server's own `detail`, verbatim — never translated.
    expect(await screen.findByRole('alert')).toHaveTextContent(/No such submission/i);
  });

  // `/submissions/$id` takes a path segment, and the router hands it over as
  // `Number(id)` — so `/submissions/abc` produced `NaN`. Observed on the live
  // stack before this guard: the page requested `GET /api/v1/submissions/NaN`
  // (422, and 502 on the retry) and rendered TanStack Query's own internal
  // wording, `["submission",null] data is undefined`, as the page body. A URL
  // typed wrong is a not-found, and it costs the API nothing to say so.
  for (const [name, id] of [
    ['not a number at all', Number('abc')],
    ['a fraction', 4.5],
    ['zero', 0],
    ['negative', -1],
  ] as const) {
    it(`answers not-found for an id that is ${name}, without asking the API`, async () => {
      wrap(<SubmissionPage id={id} />);
      expect(await screen.findByRole('alert')).toHaveTextContent(/Không có bài nộp/i);
      // `/auth/me` is the shell's own call and is expected; what must never
      // go out is the request for an id the API cannot parse.
      expect(get).not.toHaveBeenCalledWith('/submissions/{id}', expect.anything());
    });
  }

  // D123 — the reader who may see the source gets two client-only tools next
  // to it: copy it to the clipboard, and download it as a file. Both are a
  // pure convenience over source already on screen; neither touches the API.
  describe('source tools (D123)', () => {
    it('copies the exact source to the clipboard and confirms it', async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      get.mockResolvedValue({ data: DETAIL });
      wrap(<SubmissionPage id={42} />);

      await userEvent.click(await screen.findByRole('button', { name: /^Sao chép$/ }));

      // The clipboard receives the source verbatim — not a trimmed or
      // re-serialised copy.
      expect(writeText).toHaveBeenCalledWith(DETAIL.source);
      // A live region, so a screen-reader user who pressed Copy is told it
      // worked (WCAG 4.1.3); it stays on screen rather than flashing away.
      expect(await screen.findByText(/Đã sao chép/)).toHaveAttribute('role', 'status');
    });

    it('surfaces a rejected clipboard without claiming success', async () => {
      const writeText = vi.fn(async () => {
        throw new Error('denied');
      });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      get.mockResolvedValue({ data: DETAIL });
      wrap(<SubmissionPage id={42} />);

      await userEvent.click(await screen.findByRole('button', { name: /^Sao chép$/ }));

      // A refused (or absent) clipboard is a graceful fallback message, never
      // a false "copied". The source is on screen either way.
      expect(await screen.findByRole('alert')).toHaveTextContent(/tự sao chép/i);
      expect(screen.queryByText(/Đã sao chép/)).toBeNull();
    });

    for (const [languageKey, ext] of [
      ['cpp17', 'cpp'],
      ['py3', 'py'],
      ['java', 'java'],
      ['scratch', 'txt'],
    ] as const) {
      it(`downloads the source as submission-42.${ext} for ${languageKey}`, async () => {
        const url = 'blob:duckoj/42';
        const createObjectURL = vi.fn(() => url);
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        const clicks: Array<{ href: string; download: string }> = [];
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
          this: HTMLAnchorElement,
        ) {
          clicks.push({ href: this.href, download: this.download });
        });
        get.mockResolvedValue({ data: { ...DETAIL, languageKey } });
        wrap(<SubmissionPage id={42} />);

        await userEvent.click(await screen.findByRole('button', { name: /^Tải xuống$/ }));

        // The extension follows the language, and the id names the file.
        expect(clicks).toHaveLength(1);
        expect(clicks[0]!.download).toBe(`submission-42.${ext}`);
        // The object URL is created for the click and revoked after it — no
        // leaked handle.
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(clicks[0]!.href).toBe(url);
        expect(revokeObjectURL).toHaveBeenCalledWith(url);
      });
    }

    it('offers no source tools when the source is withheld', async () => {
      get.mockResolvedValue({ data: { ...DETAIL, source: null, sourceHidden: true } });
      wrap(<SubmissionPage id={42} />);
      await screen.findByRole('heading', { name: /Bài nộp #42/ });

      // Masked source (D27) — nothing to copy or download.
      expect(screen.queryByRole('button', { name: /^Sao chép$/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Tải xuống$/ })).toBeNull();
    });
  });
});

import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { ProblemLanguageLimitsTab } from '../src/routes/problem-language-limits.js';

// Same shape problem-edit.spec.tsx uses: mock the SDK client whole, so this
// page reaches the network only through `api`. `PUT` is new here — no form in
// this app had ever sent one.
vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), PUT: vi.fn() },
}));

// D147's guard reaches the router; this tab renders bare, so the blocker is
// observed rather than driven.
const { blocker } = vi.hoisted(() => ({ blocker: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useBlocker: (...args: unknown[]) => blocker(...args) as unknown,
}));

const mockedGet = vi.mocked(api.GET);
const mockedPut = vi.mocked(api.PUT);

/**
 * `aplusb` authored at 1000 ms / 256000 KB, with migration 0042's own
 * catalogue: `cpp17` unadjusted and `python3` at 300 % / +32768 KB, neither
 * overridden. These are the numbers `apps/api`'s own spec pins from the other
 * end, deliberately.
 */
const SETTINGS = {
  base: { timeMs: 1000, memoryKb: 256_000 },
  languages: [
    {
      languageKey: 'cpp17',
      languageName: 'C++17',
      defaultTimeMultiplierPct: 100,
      defaultMemoryExtraKb: 0,
      timeMultiplierPct: null,
      memoryExtraKb: null,
      allowed: true,
    },
    {
      languageKey: 'python3',
      languageName: 'Python 3',
      defaultTimeMultiplierPct: 300,
      defaultMemoryExtraKb: 32_768,
      timeMultiplierPct: null,
      memoryExtraKb: null,
      allowed: true,
    },
  ],
};

function renderTab(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <ProblemLanguageLimitsTab code="aplusb" />
    </QueryClientProvider>
  );
  return render(ui);
}

/** A table row, found by the language name in its row header. */
function rowFor(name: string): HTMLElement {
  return screen.getByRole('row', {
    name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  });
}

afterEach(() => {
  mockedGet.mockReset();
  mockedPut.mockReset();
  blocker.mockReset();
});

describe('the language-limits form (D159)', () => {
  it('shows an unoverridden language as EMPTY, with the default it inherits as the hint', async () => {
    mockedGet.mockResolvedValue({ data: SETTINGS } as never);
    renderTab();

    const time = await screen.findByLabelText(/Tỉ lệ thời gian cho Python 3/);
    const memory = screen.getByLabelText(/Bộ nhớ cộng thêm cho Python 3/);
    // The box is empty and the placeholder names the inherited value. A form
    // that prefilled "300" would have no way left to express "inherit": the
    // next save would pin what had only ever been a default, and a later
    // change to the language's own multiplier would silently stop reaching
    // this problem.
    expect(time).toHaveValue(null);
    expect(time).toHaveAttribute('placeholder', expect.stringContaining('300'));
    expect(memory).toHaveValue(null);
    expect(memory).toHaveAttribute('placeholder', expect.stringContaining('32768'));
  });

  it('previews the resulting limits with the same arithmetic the judge uses', async () => {
    mockedGet.mockResolvedValue({ data: SETTINGS } as never);
    renderTab();
    await screen.findByLabelText(/Tỉ lệ thời gian cho Python 3/);

    // Unedited: 300 % of 1000 ms and 256000 + 32768 KB, which is exactly what
    // `GET /problems/aplusb` reports for this pupil-facing pair.
    expect(within(rowFor('Python 3')).getByText(/3 giây và 282 MB/)).toBeInTheDocument();
    expect(within(rowFor('C++17')).getByText(/1 giây và 250 MB/)).toBeInTheDocument();
  });

  it('keeps the memory floor when only the time is pinned — null is inherit, not zero', async () => {
    const user = userEvent.setup();
    mockedGet.mockResolvedValue({ data: SETTINGS } as never);
    mockedPut.mockResolvedValue({ data: SETTINGS } as never);
    renderTab();

    const time = await screen.findByLabelText(/Tỉ lệ thời gian cho Python 3/);
    await user.clear(time);
    await user.type(time, '150');

    // The preview: 150 % of 1000 ms, and the interpreter's 32 MB floor STILL
    // added. If the empty memory box meant 0 the cell would read 250 MB, and
    // every Python submission on this problem would MRE.
    expect(within(rowFor('Python 3')).getByText(/1.5 giây và 282 MB/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Lưu/ }));
    await waitFor(() => {
      expect(mockedPut).toHaveBeenCalled();
    });
    const body = mockedPut.mock.calls[0]![1] as unknown as { body: { limits: unknown[] } };
    // On the wire it is `null`, never `0`. `Number('')` is 0, and that single
    // coercion is the whole hazard this screen is written around.
    expect(body.body.limits).toEqual([
      { languageKey: 'cpp17', timeMultiplierPct: null, memoryExtraKb: null, allowed: true },
      { languageKey: 'python3', timeMultiplierPct: 150, memoryExtraKb: null, allowed: true },
    ]);
  });

  it('says "not allowed", never "0 giây"', async () => {
    const user = userEvent.setup();
    mockedGet.mockResolvedValue({ data: SETTINGS } as never);
    mockedPut.mockResolvedValue({ data: SETTINGS } as never);
    renderTab();

    const allowed = await screen.findByLabelText(/Cho phép nộp bằng Python 3/);
    await user.click(allowed);

    const row = rowFor('Python 3');
    // D154: a refusal is a 404 at submit time, not a time limit of zero — a
    // zero would present the refusal as a TLE and teach the pupil their
    // correct program was too slow.
    expect(within(row).getByText(/Không cho phép/)).toBeInTheDocument();
    expect(within(row).queryByText(/0 giây/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Lưu/ }));
    await waitFor(() => {
      expect(mockedPut).toHaveBeenCalled();
    });
    const body = mockedPut.mock.calls[0]![1] as unknown as {
      body: {
        limits: { languageKey: string; allowed: boolean; timeMultiplierPct: number | null }[];
      };
    };
    const python = body.body.limits.find((l) => l.languageKey === 'python3');
    expect(python).toMatchObject({ allowed: false, timeMultiplierPct: null });
  });

  it('refuses a multiplier of 0 before it reaches the wire, and says why in the reader’s language', async () => {
    const user = userEvent.setup();
    mockedGet.mockResolvedValue({ data: SETTINGS } as never);
    renderTab();

    const time = await screen.findByLabelText(/Tỉ lệ thời gian cho Python 3/);
    await user.clear(time);
    await user.type(time, '0');
    await user.click(screen.getByRole('button', { name: /Lưu/ }));

    // Nothing was sent — the first of three layers (the API and the database
    // refuse it independently).
    expect(mockedPut).not.toHaveBeenCalled();
    // D110's focusable summary, and the message names the alternative rather
    // than just the range: a setter who wants "not solvable in Python" is
    // being told where that switch is.
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent(/100%/);
    expect(summary).toHaveTextContent(/Cho phép/);
    // D146's wiring — the objection is the field's description, not just a
    // banner sentence.
    expect(time).toHaveAttribute('aria-invalid', 'true');
  });

  it('says so when there is nothing to preview against, rather than inventing a base', async () => {
    mockedGet.mockResolvedValue({
      data: { ...SETTINGS, base: null },
    } as never);
    renderTab();

    // A problem with no published revision has no authored limits to adjust.
    // The overrides are still editable — "Python is refused here" is a
    // statement about the problem, sayable before its tests exist.
    expect(await screen.findByText(/chưa có phiên bản được xuất bản/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tỉ lệ thời gian cho Python 3/)).toBeEnabled();
  });
});

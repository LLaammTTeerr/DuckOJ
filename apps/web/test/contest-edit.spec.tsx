/**
 * `/contests/$key/edit`.
 *
 * The two things worth pinning: the form actually arrives prefilled (an edit
 * screen that silently starts empty saves a blank contest over a real one),
 * and the times survive the round trip through `datetime-local`, which speaks
 * the browser's zone and no other.
 */
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const patch = vi.fn();
const navigate = vi.fn();
const blocker = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: vi.fn(), PATCH: (...a: unknown[]) => patch(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => navigate,
  // D147's dirty guard hangs off the router; the page renders bare here.
  useBlocker: (...args: unknown[]) => blocker(...args) as unknown,
}));

const { ContestEditPage } = await import('../src/routes/contest-edit.js');
const { ContestPage } = await import('../src/routes/contests.js');

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** A start and end expressed as instants, so the assertions are zone-free. */
const START = new Date(Date.now() + 3_600_000);
const END = new Date(Date.now() + 7_200_000);

const CONTEST = {
  id: 1,
  key: 'spring',
  name: 'Spring Open',
  startTime: START.toISOString(),
  endTime: END.toISOString(),
  format: 'icpc',
  visibility: 'public' as const,
  pointsPrecision: 3,
  frozenLastMinutes: 0,
  timeLimitSeconds: null,
  isRated: false,
  createdAt: new Date().toISOString(),
  formatConfig: null,
  canEdit: true,
  // D56: every contest response carries its organizations, empty when
  // nothing restricts it.
  orgs: [],
  problems: [{ code: 'aplusb', name: 'A plus B', label: 'A', points: 100, partial: true, order: 0 }],
};

afterEach(() => {
  get.mockReset();
  patch.mockReset();
  navigate.mockReset();
  blocker.mockReset();
});

describe('ContestEditPage', () => {
  it('prefills from the contest, including its problem rows', async () => {
    get.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);

    expect(await screen.findByRole('heading', { name: /sửa spring/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Tên')).toHaveValue('Spring Open');
    expect(screen.getByLabelText('Thể thức')).toHaveValue('icpc');
    expect(screen.getByLabelText('Phạm vi')).toHaveValue('public');
    expect(screen.getByLabelText('Mã bài 1')).toHaveValue('aplusb');
    expect(screen.getByLabelText('Điểm bài 1')).toHaveValue('100');
  });

  it('sends the instants it was given back unchanged when the times are untouched', async () => {
    get.mockResolvedValue({ data: CONTEST });
    patch.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);

    await userEvent.clear(await screen.findByLabelText('Tên'));
    await userEvent.type(screen.getByLabelText('Tên'), 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu kỳ thi' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0]![1].body as { startTime: string; endTime: string; name: string };
    expect(body.name).toBe('Renamed');
    // EXACT, to the millisecond (m5). `datetime-local` shows minutes, so a
    // field the organiser never touched used to save back up to 59 s EARLY —
    // and an `endTime` that moves earlier voids a genuinely last-minute
    // submission, since the participation window is what `lower()` filters on.
    expect(body.startTime).toBe(START.toISOString());
    expect(body.endTime).toBe(END.toISOString());
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('sends the edited instant when a time IS touched', async () => {
    get.mockResolvedValue({ data: CONTEST });
    patch.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);

    const ends = await screen.findByLabelText('Kết thúc');
    await userEvent.clear(ends);
    await userEvent.type(ends, '2027-01-02T03:04');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu kỳ thi' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0]![1].body as { startTime: string; endTime: string };
    expect(body.endTime).toBe(new Date('2027-01-02T03:04').toISOString());
    // The untouched one still round-trips exactly.
    expect(body.startTime).toBe(START.toISOString());
  });

  it('refuses an emptied freeze field rather than silently turning the freeze off', async () => {
    get.mockResolvedValue({ data: { ...CONTEST, frozenLastMinutes: 60 } });
    patch.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);

    // `Number('')` is 0 and `Number.isInteger(0)` is true (m6), so an empty
    // box used to PATCH `frozenLastMinutes: 0` — the freeze, off, with no
    // sign that anything happened.
    await userEvent.clear(await screen.findByLabelText('Đóng băng (phút)'));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu kỳ thi' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("carries each problem's label back unchanged, and omits it for a row added here", async () => {
    // `problems` is replaced wholesale by the API, so anything this form
    // drops the save destroys — and a dropped label also makes an untouched
    // save of a running contest a 409 `contest_started`, because the
    // server's "did anything change?" check compares labels.
    get.mockResolvedValue({ data: CONTEST });
    patch.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Thêm bài' }));
    await userEvent.type(screen.getByLabelText('Mã bài 2'), 'newone');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu kỳ thi' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0]![1].body as { problems: Record<string, unknown>[] };
    expect(body.problems[0]).toEqual({ code: 'aplusb', points: 100, partial: true, label: 'A' });
    // No label at all for the new row — the API defaults it to the position,
    // which this form has no business second-guessing.
    expect(body.problems[1]).toEqual({ code: 'newone', points: 100, partial: true });
  });

  it('shows the server refusal verbatim and never wedges the button', async () => {
    get.mockResolvedValue({ data: CONTEST });
    patch.mockResolvedValue({ error: { code: 'contest_started', detail: 'This contest has started.' } });
    wrap(<ContestEditPage contestKey="spring" />);

    const save = await screen.findByRole('button', { name: 'Lưu kỳ thi' });
    await userEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('This contest has started.');
    await waitFor(() => expect(save).not.toBeDisabled());
    expect(navigate).not.toHaveBeenCalled();

    patch.mockRejectedValue(new TypeError('Failed to fetch'));
    await userEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent(/không kết nối được máy chủ/i);
    await waitFor(() => expect(save).not.toBeDisabled());
  });
});

describe('the link into it', () => {
  it('appears on the contest page only when the server says the caller may edit', async () => {
    get.mockImplementation((path: string) =>
      path === '/contests/{key}'
        ? Promise.resolve({ data: CONTEST })
        : Promise.resolve({ data: undefined }),
    );
    const view = wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('link', { name: /sửa kỳ thi/i })).toBeInTheDocument();
    view.unmount();

    get.mockImplementation((path: string) =>
      path === '/contests/{key}'
        ? Promise.resolve({ data: { ...CONTEST, canEdit: false } })
        : Promise.resolve({ data: undefined }),
    );
    wrap(<ContestPage contestKey="spring" />);
    expect(await screen.findByRole('heading', { name: /spring open/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sửa kỳ thi/i })).toBeNull();
  });
});

/**
 * D146/D147/D148 on the screen that edits a contest while it is being run.
 * Before this loop a refused save was one banner in the pipe's English, the
 * button went grey when the name was cleared with no reason given, and a
 * click on the cancel link took every edit with it.
 */
describe('ContestEditPage — the form teaches, and keeps what was typed', () => {
  it('names the cleared field instead of quietly killing the button', async () => {
    get.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);
    await screen.findByDisplayValue('Spring Open');
    await userEvent.clear(screen.getByLabelText('Tên'));

    const save = screen.getByRole('button', { name: /^Lưu/ });
    expect(save).not.toBeDisabled();
    await userEvent.click(save);

    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Tên')).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  });

  it('names the END field when the window would run backwards', async () => {
    get.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);
    await screen.findByDisplayValue('Spring Open');
    const end = screen.getByLabelText('Kết thúc');
    await userEvent.clear(end);
    await userEvent.type(end, '2020-01-01T00:00');
    await userEvent.click(screen.getByRole('button', { name: /^Lưu/ }));

    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Kết thúc')).toHaveAttribute('aria-invalid', 'true');
  });

  it('puts the server 422 on the field the server named (D146)', async () => {
    get.mockResolvedValue({ data: CONTEST });
    patch.mockResolvedValue({
      data: undefined,
      error: {
        code: 'validation_failed',
        detail: 'The request body failed validation.',
        fields: { frozenLastMinutes: ['Too long'] },
      },
      response: { status: 422 },
    });
    wrap(<ContestEditPage contestKey="spring" />);
    await screen.findByDisplayValue('Spring Open');
    await userEvent.click(screen.getByRole('button', { name: /^Lưu/ }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const freeze = screen.getByLabelText(/Đóng băng/);
    await waitFor(() => expect(freeze).toHaveAttribute('aria-invalid', 'true'));
    expect(document.getElementById(freeze.getAttribute('aria-describedby')!)).toHaveTextContent(
      'Too long',
    );
  });

  it('keeps every edit when the save is refused', async () => {
    get.mockResolvedValue({ data: CONTEST });
    patch.mockResolvedValue({ data: undefined, error: { code: 'contest_started' } });
    wrap(<ContestEditPage contestKey="spring" />);
    await screen.findByDisplayValue('Spring Open');
    await userEvent.clear(screen.getByLabelText('Tên'));
    await userEvent.type(screen.getByLabelText('Tên'), 'Vòng tỉnh');
    await userEvent.click(screen.getByRole('button', { name: /^Lưu/ }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Tên')).toHaveValue('Vòng tỉnh');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says it is saving, and cannot be double-submitted (D148)', async () => {
    get.mockResolvedValue({ data: CONTEST });
    patch.mockReturnValue(new Promise(() => undefined));
    wrap(<ContestEditPage contestKey="spring" />);
    await screen.findByDisplayValue('Spring Open');
    await userEvent.click(screen.getByRole('button', { name: /^Lưu/ }));

    const busy = await screen.findByRole('button', { name: /Đang lưu/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(busy);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('guards an edited contest against a route change, not an untouched one (D147)', async () => {
    get.mockResolvedValue({ data: CONTEST });
    wrap(<ContestEditPage contestKey="spring" />);
    await screen.findByDisplayValue('Spring Open');
    // Prefilled is not edited: the seed is the contest's own values.
    await waitFor(() =>
      expect((blocker.mock.calls.at(-1)![0] as { disabled: boolean }).disabled).toBe(true),
    );

    await userEvent.type(screen.getByLabelText('Tên'), ' 2026');
    await waitFor(() =>
      expect((blocker.mock.calls.at(-1)![0] as { disabled: boolean }).disabled).toBe(false),
    );
  });
});

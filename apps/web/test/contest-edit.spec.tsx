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
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: vi.fn(), PATCH: (...a: unknown[]) => patch(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => navigate,
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
  problems: [{ code: 'aplusb', name: 'A plus B', label: 'A', points: 100, partial: true, order: 0 }],
};

afterEach(() => {
  get.mockReset();
  patch.mockReset();
  navigate.mockReset();
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

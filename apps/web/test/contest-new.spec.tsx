import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const get = vi.fn();
const navigate = vi.fn();
const blocker = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { POST: (...a: unknown[]) => post(...a), GET: (...a: unknown[]) => get(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => navigate,
  // D147's dirty guard hangs off the router; the page renders bare here.
  useBlocker: (...args: unknown[]) => blocker(...args) as unknown,
}));

const { ContestNewPage } = await import('../src/routes/contest-new.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  post.mockReset();
  get.mockReset();
  navigate.mockReset();
  blocker.mockReset();
});

/** The contest `?cloneFrom=` names, as `GET /contests/{key}` answers it. */
const SOURCE = {
  key: 'tinh-2026',
  name: 'Vòng tỉnh 2026',
  format: 'ioi16',
  frozenLastMinutes: 15,
  problems: [
    { code: 'p1', label: 'A', points: 100, partial: true, order: 0 },
    { code: 'p2', label: 'B', points: 50, partial: false, order: 1 },
  ],
  orgs: [{ slug: 'truong-a', name: 'Trường A' }],
};

async function fillBasics() {
  await userEvent.type(screen.getByLabelText(/^Mã kỳ thi/), 'spring');
  await userEvent.type(screen.getByLabelText(/^Tên/), 'Spring Open');
  // datetime-local inputs: type a full local stamp.
  await userEvent.type(screen.getByLabelText(/Bắt đầu/), '2026-09-01T09:00');
  await userEvent.type(screen.getByLabelText(/Kết thúc/), '2026-09-01T14:00');
}

describe('ContestNewPage', () => {
  it('sends instants, not zoneless strings, and navigates to the created key', async () => {
    post.mockResolvedValue({ data: { key: 'spring' } });
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.type(screen.getByLabelText(/Mã bài 1/), 'aplusb');
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));

    const body = (post.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body;
    // The instant of 09:00 local, whatever zone the test runs in — an ISO
    // string with a Z, parseable back to the same clock reading.
    expect(String(body.startTime)).toMatch(/Z$/);
    expect(new Date(String(body.startTime)).getTime()).toBe(new Date('2026-09-01T09:00').getTime());
    expect(body.problems).toEqual([{ code: 'aplusb', points: 100, partial: true }]);
    expect(navigate).toHaveBeenCalledWith({ to: '/contests/$key', params: { key: 'spring' } });
  });

  it('refuses non-numeric points before bothering the API', async () => {
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.type(screen.getByLabelText(/Mã bài 1/), 'aplusb');
    await userEvent.clear(screen.getByLabelText(/Điểm bài 1/));
    await userEvent.type(screen.getByLabelText(/Điểm bài 1/), 'lots');
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/điểm phải là số không âm/);
    expect(post).not.toHaveBeenCalled();
  });

  it('a blank problem row is dropped, not sent as an empty code', async () => {
    post.mockResolvedValue({ data: { key: 'spring' } });
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));
    const body = (post.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body;
    expect(body.problems).toEqual([]);
  });

  it('surfaces the API detail on refusal', async () => {
    post.mockResolvedValue({ error: { detail: 'That contest key is already taken.' } });
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already taken/i);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('ContestNewPage transport failures', () => {
  it('surfaces a connection message and re-enables the button when the network fails', async () => {
    post.mockRejectedValue(new TypeError('fetch failed'));
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không kết nối được máy chủ/);
    expect(screen.getByRole('button', { name: /Tạo kỳ thi/ })).toBeEnabled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('cloning a contest from this screen (D88)', () => {
  it('seeds a key and a name, shows what will be copied, and posts only the new window', async () => {
    get.mockResolvedValue({ data: SOURCE, error: undefined });
    post.mockResolvedValue({ data: { key: 'tinh-2026-2' } });
    wrap(<ContestNewPage cloneFrom="tinh-2026" />);

    // Seeded from the source — a suggestion, not the source's own key,
    // which is taken by definition.
    const key = await screen.findByLabelText(/^Mã kỳ thi/);
    await waitFor(() => expect(key).toHaveValue('tinh-2026-2'));
    expect(screen.getByLabelText(/^Tên/)).toHaveValue('Vòng tỉnh 2026 (bản sao)');

    // What the server copies is SHOWN, not offered as inputs whose answers
    // would be ignored.
    expect(screen.getByTestId('clone-summary')).toHaveTextContent('Bài: A. p1, B. p2');
    expect(screen.getByTestId('clone-summary')).toHaveTextContent('Trường được thi: truong-a');
    expect(screen.queryByLabelText(/Mã bài 1/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Thể thức/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/Bắt đầu/), '2027-09-01T09:00');
    await userEvent.type(screen.getByLabelText(/Kết thúc/), '2027-09-01T14:00');
    await userEvent.click(screen.getByRole('button', { name: /Nhân bản kỳ thi/ }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe('/contests/{key}/clone');
    const options = post.mock.calls[0]![1] as {
      params: { path: { key: string } };
      body: Record<string, unknown>;
    };
    expect(options.params.path.key).toBe('tinh-2026');
    expect(options.body).toEqual({
      newKey: 'tinh-2026-2',
      newName: 'Vòng tỉnh 2026 (bản sao)',
      startTime: new Date('2027-09-01T09:00').toISOString(),
      endTime: new Date('2027-09-01T14:00').toISOString(),
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/contests/$key', params: { key: 'tinh-2026-2' } });
  });

  it("shows the server's refusal and stays put", async () => {
    get.mockResolvedValue({ data: SOURCE, error: undefined });
    post.mockResolvedValue({ data: undefined, error: { code: 'contest_key_taken' } });
    wrap(<ContestNewPage cloneFrom="tinh-2026" />);

    await waitFor(() => expect(screen.getByLabelText(/^Mã kỳ thi/)).toHaveValue('tinh-2026-2'));
    await userEvent.type(screen.getByLabelText(/Bắt đầu/), '2027-09-01T09:00');
    await userEvent.type(screen.getByLabelText(/Kết thúc/), '2027-09-01T14:00');
    await userEvent.click(screen.getByRole('button', { name: /Nhân bản kỳ thi/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('contest_key_taken'));
    expect(navigate).not.toHaveBeenCalled();
  });
});

/**
 * D146/D147/D148 on the one form a contest day cannot afford to lose. Before
 * this loop the button simply went grey when the key was empty (no reason
 * given, nowhere to look), every refusal was one banner, and a route change
 * took a half-written contest with it.
 */
describe('ContestNewPage — the form teaches, and keeps what was typed', () => {
  it('names the empty field and moves focus there instead of a dead button', async () => {
    wrap(<ContestNewPage />);
    const button = screen.getByRole('button', { name: /Tạo kỳ thi/ });
    // The button is live: a disabled control tells a setter nothing about
    // WHICH of eleven inputs it is waiting for.
    expect(button).not.toBeDisabled();
    await userEvent.click(button);

    expect(post).not.toHaveBeenCalled();
    const summary = screen.getByRole('alert');
    expect(summary).toHaveTextContent('Vui lòng sửa các lỗi sau');
    await waitFor(() => expect(summary).toHaveFocus());
    // and the objection is the field's own description, not a stray line
    const key = screen.getByLabelText(/^Mã kỳ thi/);
    expect(key).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(key.getAttribute('aria-describedby')!)).toHaveTextContent(/bắt buộc/i);
  });

  it('refuses a key the contract would refuse, before any request', async () => {
    wrap(<ContestNewPage />);
    await userEvent.type(screen.getByLabelText(/^Mã kỳ thi/), 'Spring Open');
    await userEvent.type(screen.getByLabelText(/^Tên/), 'Spring Open');
    await userEvent.type(screen.getByLabelText(/Bắt đầu/), '2026-09-01T09:00');
    await userEvent.type(screen.getByLabelText(/Kết thúc/), '2026-09-01T14:00');
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));

    expect(post).not.toHaveBeenCalled();
    const key = screen.getByLabelText(/^Mã kỳ thi/);
    expect(key).toHaveAttribute('aria-invalid', 'true');
  });

  it('names the END field when the round would finish before it starts', async () => {
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.clear(screen.getByLabelText(/Kết thúc/));
    await userEvent.type(screen.getByLabelText(/Kết thúc/), '2026-09-01T08:00');
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));

    expect(post).not.toHaveBeenCalled();
    // Not a banner saying `contest_window_invalid` after a round trip: the
    // API answers that as a 400 with no field attribution at all.
    expect(screen.getByLabelText(/Kết thúc/)).toHaveAttribute('aria-invalid', 'true');
  });

  it("puts the server's 422 on the field the server named (D146)", async () => {
    post.mockResolvedValue({
      data: undefined,
      error: {
        code: 'validation_failed',
        detail: 'The request body failed validation.',
        fields: { key: ['Invalid'], 'problems.0.points': ['Expected number'] },
      },
      response: { status: 422 },
    });
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.type(screen.getByLabelText(/Mã bài 1/), 'aplusb');
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const key = await screen.findByLabelText(/^Mã kỳ thi/);
    await waitFor(() => expect(key).toHaveAttribute('aria-invalid', 'true'));
    expect(document.getElementById(key.getAttribute('aria-describedby')!)).toHaveTextContent('Invalid');
    // …and the per-row objection reaches the problems table through the
    // wildcard, rather than vanishing with the rest of `fields`.
    expect(screen.getByRole('alert')).toHaveTextContent('Expected number');
  });

  it('keeps every typed value when the save fails', async () => {
    post.mockResolvedValue({ data: undefined, error: { code: 'contest_key_taken' } });
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.type(screen.getByLabelText(/Mã bài 1/), 'aplusb');
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText(/^Mã kỳ thi/)).toHaveValue('spring');
    expect(screen.getByLabelText(/^Tên/)).toHaveValue('Spring Open');
    expect(screen.getByLabelText(/Mã bài 1/)).toHaveValue('aplusb');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says what it is doing while the contest is being created (D148)', async () => {
    let release!: () => void;
    post.mockReturnValue(new Promise((resolve) => {
      release = () => resolve({ data: { key: 'spring' } });
    }));
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.click(screen.getByRole('button', { name: /Tạo kỳ thi/ }));

    const busy = await screen.findByRole('button', { name: /Đang tạo/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    release();
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('cannot be double-submitted by two fast clicks (D148)', async () => {
    post.mockReturnValue(new Promise(() => undefined));
    wrap(<ContestNewPage />);
    await fillBasics();
    const button = screen.getByRole('button', { name: /Tạo kỳ thi/ });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('guards a half-written contest against a route change (D147)', async () => {
    wrap(<ContestNewPage />);
    // Untouched, the guard is off — nobody wants a prompt for opening a form
    // and changing their mind.
    expect((blocker.mock.calls.at(-1)![0] as { disabled: boolean }).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/^Tên/), 'Spring Open');
    await waitFor(() =>
      expect((blocker.mock.calls.at(-1)![0] as { disabled: boolean }).disabled).toBe(false),
    );
  });
});

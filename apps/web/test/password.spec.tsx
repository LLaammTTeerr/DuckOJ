/**
 * `/account/password` — the one form on this site every roster-imported pupil
 * must get through before they can see anything at all (D61).
 *
 * It objected on every KEYSTROKE: "Ngắn hơn 10 ký tự." appeared on the first
 * character and stayed for nine more, and "Hai ô không khớp nhau." sat under
 * the confirm box for the whole time it was being typed. An objection that is
 * true only because you have not finished yet is not teaching anybody
 * anything — it is a form telling a child they are wrong while they type.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const get = vi.fn();
const post = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));

const { ChangePasswordPage } = await import('../src/routes/password.js');

const ME = { id: 1, username: 'hocsinh1', displayName: 'Học sinh 1', mustChangePassword: false };

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('ChangePasswordPage', () => {
  async function open(): Promise<void> {
    get.mockResolvedValue({ data: ME, error: undefined, response: new Response() });
    wrap(<ChangePasswordPage />);
    await screen.findByLabelText(/^Mật khẩu mới/);
  }

  it('says nothing while a long password is still being typed', async () => {
    await open();
    await userEvent.type(screen.getByLabelText(/^Mật khẩu mới/), 'matkhau');

    expect(screen.queryByText(/Ngắn hơn/)).toBeNull();
  });

  it('says nothing about a mismatch while the confirmation is half typed', async () => {
    await open();
    await userEvent.type(screen.getByLabelText(/^Mật khẩu mới/), 'matkhaudai1');
    await userEvent.type(screen.getByLabelText(/Nhập lại/), 'matkh');

    expect(screen.queryByText(/không khớp/)).toBeNull();
  });

  it('objects once the field is left, tied to the field it is about', async () => {
    await open();
    const next = screen.getByLabelText(/^Mật khẩu mới/);
    await userEvent.type(next, 'ngan');
    await userEvent.tab();

    await waitFor(() => expect(next).toHaveAttribute('aria-invalid', 'true'));
    expect(document.getElementById(next.getAttribute('aria-describedby')!)).toHaveTextContent(
      /Ngắn hơn/,
    );
  });

  it('does not rip focus away from the box the reader just tabbed into', async () => {
    await open();
    // D110's summary takes focus when it appears, which is right for a failed
    // submit and catastrophic for a blur: raising it here would throw the
    // reader out of the confirm box on the way into it, every time.
    await userEvent.type(screen.getByLabelText(/^Mật khẩu mới/), 'ngan');
    await userEvent.tab();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText(/Nhập lại/)).toHaveFocus();
  });

  it('is pressable when incomplete, and answers with the reason rather than nothing', async () => {
    await open();
    const button = screen.getByRole('button', { name: 'Đổi mật khẩu' });
    // A dead button tells a pupil nothing about which of three boxes it wants.
    expect(button).not.toBeDisabled();
    await userEvent.click(button);

    expect(post).not.toHaveBeenCalled();
    const summary = screen.getByRole('alert');
    await waitFor(() => expect(summary).toHaveFocus());
    expect(summary).toHaveTextContent('Vui lòng sửa các lỗi sau');
  });

  it('keeps what was typed when the server refuses the change', async () => {
    await open();
    post.mockResolvedValue({ data: undefined, error: { code: 'password_wrong', detail: 'Nope.' } });
    await userEvent.type(screen.getByLabelText(/Mật khẩu hiện tại/), 'cu-cua-toi');
    await userEvent.type(screen.getByLabelText(/^Mật khẩu mới/), 'matkhaudai1');
    await userEvent.type(screen.getByLabelText(/Nhập lại/), 'matkhaudai1');
    await userEvent.click(screen.getByRole('button', { name: 'Đổi mật khẩu' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText(/^Mật khẩu mới/)).toHaveValue('matkhaudai1');
    expect(screen.getByLabelText(/Nhập lại/)).toHaveValue('matkhaudai1');
  });

  it('says what it is doing while the change is in flight (D148)', async () => {
    await open();
    post.mockReturnValue(new Promise(() => undefined));
    await userEvent.type(screen.getByLabelText(/Mật khẩu hiện tại/), 'cu-cua-toi');
    await userEvent.type(screen.getByLabelText(/^Mật khẩu mới/), 'matkhaudai1');
    await userEvent.type(screen.getByLabelText(/Nhập lại/), 'matkhaudai1');
    await userEvent.click(screen.getByRole('button', { name: 'Đổi mật khẩu' }));

    const busy = await screen.findByRole('button', { name: /Đang lưu/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('../src/api.js', () => ({ api: { POST: (...args: unknown[]) => post(...args) } }));

const search = vi.fn(() => ({}) as Record<string, unknown>);
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => search(),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } = await import(
  '../src/routes/account-recovery.js'
);

afterEach(() => {
  post.mockReset();
  search.mockReturnValue({});
});

describe('ForgotPasswordPage', () => {
  it('says the same thing whether or not the account exists', async () => {
    post.mockResolvedValue({ error: undefined });
    render(<ForgotPasswordPage />);
    await userEvent.type(screen.getByLabelText(/email/i), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: /Gửi liên kết đặt lại/ }));

    // "If that address has an account" — the server refuses to say, and the
    // screen must not undo that by only confirming for real addresses.
    expect(await screen.findByRole('status')).toHaveTextContent(/Nếu địa chỉ đó có tài khoản/);
    expect(post).toHaveBeenCalledWith('/auth/password/forgot', {
      body: { email: 'someone@example.com' },
    });
  });
});

describe('ResetPasswordPage', () => {
  it('refuses to render a form without a token', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(/thiếu mã/);
    expect(screen.queryByLabelText(/Mật khẩu mới/)).toBeNull();
  });

  it('submits the token from the query string with the new password', async () => {
    search.mockReturnValue({ token: 'tok-123' });
    post.mockResolvedValue({ error: undefined });
    render(<ResetPasswordPage />);

    await userEvent.type(screen.getByLabelText(/Mật khẩu mới/), 'an-even-longer-password');
    await userEvent.click(screen.getByRole('button', { name: /Đổi mật khẩu/ }));

    expect(post).toHaveBeenCalledWith('/auth/password/reset', {
      body: { token: 'tok-123', password: 'an-even-longer-password' },
    });
    // The user is told their other sessions ended, because they did.
    expect(await screen.findByRole('status')).toHaveTextContent(/đã bị đăng xuất/);
  });

  it('shows the server message when the link is spent', async () => {
    search.mockReturnValue({ token: 'tok-used' });
    post.mockResolvedValue({ error: { detail: 'That link is invalid or has expired.' } });
    render(<ResetPasswordPage />);
    await userEvent.type(screen.getByLabelText(/Mật khẩu mới/), 'an-even-longer-password');
    await userEvent.click(screen.getByRole('button', { name: /Đổi mật khẩu/ }));
    // English on purpose: this asserts the SERVER's `detail` reaching the
    // screen verbatim, which is never translated (see i18n/en.ts's header).
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid or has expired/i);
  });
});

describe('VerifyEmailPage', () => {
  it('waits for a click rather than spending the token on mount', async () => {
    search.mockReturnValue({ token: 'tok-verify' });
    post.mockResolvedValue({ error: undefined });
    render(<VerifyEmailPage />);

    // Link prefetchers and mail scanners follow URLs. A token spent on mount
    // is a token the user never gets to use, so nothing has been called yet.
    expect(post).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Xác nhận địa chỉ/ }));
    expect(post).toHaveBeenCalledWith('/auth/email/verify', { body: { token: 'tok-verify' } });
    expect(await screen.findByRole('status')).toHaveTextContent(/Đã xác nhận địa chỉ/);
  });

  it('disables the button when the link carried no token', () => {
    render(<VerifyEmailPage />);
    expect(screen.getByRole('button', { name: /Xác nhận địa chỉ/ })).toBeDisabled();
  });
});

describe('ForgotPasswordPage transport failures', () => {
  it('surfaces a connection message instead of saying Working… forever', async () => {
    post.mockRejectedValue(new TypeError('fetch failed'));
    render(<ForgotPasswordPage />);
    await userEvent.type(screen.getByLabelText(/email/i), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: /Gửi liên kết đặt lại/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không kết nối được máy chủ/);
    // The button reads "Send reset link" again — not a stuck "Working…".
    expect(screen.getByRole('button', { name: /Gửi liên kết đặt lại/ })).toBeEnabled();
  });
});

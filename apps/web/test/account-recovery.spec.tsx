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
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    // "If that address has an account" — the server refuses to say, and the
    // screen must not undo that by only confirming for real addresses.
    expect(await screen.findByRole('status')).toHaveTextContent(/if that address has an account/i);
    expect(post).toHaveBeenCalledWith('/auth/password/forgot', {
      body: { email: 'someone@example.com' },
    });
  });
});

describe('ResetPasswordPage', () => {
  it('refuses to render a form without a token', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(/missing its token/i);
    expect(screen.queryByLabelText(/new password/i)).toBeNull();
  });

  it('submits the token from the query string with the new password', async () => {
    search.mockReturnValue({ token: 'tok-123' });
    post.mockResolvedValue({ error: undefined });
    render(<ResetPasswordPage />);

    await userEvent.type(screen.getByLabelText(/new password/i), 'an-even-longer-password');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));

    expect(post).toHaveBeenCalledWith('/auth/password/reset', {
      body: { token: 'tok-123', password: 'an-even-longer-password' },
    });
    // The user is told their other sessions ended, because they did.
    expect(await screen.findByRole('status')).toHaveTextContent(/signed out/i);
  });

  it('shows the server message when the link is spent', async () => {
    search.mockReturnValue({ token: 'tok-used' });
    post.mockResolvedValue({ error: { detail: 'That link is invalid or has expired.' } });
    render(<ResetPasswordPage />);
    await userEvent.type(screen.getByLabelText(/new password/i), 'an-even-longer-password');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));
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

    await userEvent.click(screen.getByRole('button', { name: /confirm address/i }));
    expect(post).toHaveBeenCalledWith('/auth/email/verify', { body: { token: 'tok-verify' } });
    expect(await screen.findByRole('status')).toHaveTextContent(/confirmed/i);
  });

  it('disables the button when the link carried no token', () => {
    render(<VerifyEmailPage />);
    expect(screen.getByRole('button', { name: /confirm address/i })).toBeDisabled();
  });
});

describe('ForgotPasswordPage transport failures', () => {
  it('surfaces a connection message instead of saying Working… forever', async () => {
    post.mockRejectedValue(new TypeError('fetch failed'));
    render(<ForgotPasswordPage />);
    await userEvent.type(screen.getByLabelText(/email/i), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: /send reset link/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i);
    // The button reads "Send reset link" again — not a stuck "Working…".
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeEnabled();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginForm } from '../src/routes/login.js';

describe('LoginForm', () => {
  it('submits the entered credentials', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<LoginForm onSubmit={onSubmit} error={null} />);

    await userEvent.type(screen.getByLabelText(/Tên đăng nhập hoặc email/), 'kim');
    await userEvent.type(screen.getByLabelText(/^Mật khẩu$/), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: /^Đăng nhập$/ }));

    expect(onSubmit).toHaveBeenCalledWith({
      usernameOrEmail: 'kim',
      password: 'a-long-enough-password',
      totpCode: undefined,
      recoveryCode: undefined,
    });
  });

  it('marks the sign-in fields with their input purpose (WCAG 1.3.5)', () => {
    // The identifier and password carried no `autocomplete`, so a password
    // manager could not fill them and the browser could not offer to — the
    // TOTP step and `/account/password` already did this, so the gap was an
    // inconsistency, not a policy.
    render(<LoginForm onSubmit={vi.fn()} error={null} needsTotp />);
    expect(screen.getByLabelText(/Tên đăng nhập hoặc email/)).toHaveAttribute(
      'autocomplete',
      'username',
    );
    expect(screen.getByLabelText(/^Mật khẩu$/)).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText(/Mã xác thực hai lớp/)).toHaveAttribute(
      'autocomplete',
      'one-time-code',
    );
  });

  it('shows the server error message', () => {
    render(<LoginForm onSubmit={vi.fn()} error="Incorrect username or password." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Incorrect username or password.');
  });

  it('reveals the TOTP field only when the server asks for it', async () => {
    const { rerender } = render(<LoginForm onSubmit={vi.fn()} error={null} />);
    expect(screen.queryByLabelText(/Mã xác thực hai lớp/)).toBeNull();

    rerender(<LoginForm onSubmit={vi.fn()} error="A two-factor code is required." needsTotp />);
    expect(screen.getByLabelText(/Mã xác thực hai lớp/)).toBeInTheDocument();
  });

  // D39. The toggle exists only on the second step: offering a recovery code
  // to everyone at every sign-in is how people burn them for no reason.
  it('offers no recovery-code toggle until the second factor is asked for', () => {
    render(<LoginForm onSubmit={vi.fn()} error={null} />);
    expect(screen.queryByRole('button', { name: /Dùng mã khôi phục/ })).toBeNull();
  });

  it('swaps the TOTP field for a recovery-code field, and back', async () => {
    render(<LoginForm onSubmit={vi.fn()} error="A two-factor code is required." needsTotp />);

    await userEvent.click(screen.getByRole('button', { name: /Dùng mã khôi phục/ }));
    expect(screen.getByLabelText(/Mã khôi phục/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Mã xác thực hai lớp/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Dùng mã từ ứng dụng/ }));
    expect(screen.getByLabelText(/Mã xác thực hai lớp/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Mã khôi phục/)).toBeNull();
  });

  it('submits recoveryCode instead of totpCode, never both', async () => {
    const onSubmit = vi.fn(async () => {});
    render(
      <LoginForm onSubmit={onSubmit} error="A two-factor code is required." needsTotp />,
    );

    await userEvent.type(screen.getByLabelText(/Tên đăng nhập hoặc email/), 'kim');
    await userEvent.type(screen.getByLabelText(/^Mật khẩu$/), 'a-long-enough-password');
    // Typed into the TOTP box first, then abandoned for the recovery path —
    // the stale six digits must not ride along, because the server prefers
    // `totpCode` and would silently ignore the code the viewer actually
    // meant to use.
    await userEvent.type(screen.getByLabelText(/Mã xác thực hai lớp/), '123456');
    await userEvent.click(screen.getByRole('button', { name: /Dùng mã khôi phục/ }));
    await userEvent.type(screen.getByLabelText(/Mã khôi phục/), 'ABCDE-FGHJK');
    await userEvent.click(screen.getByRole('button', { name: /^Đăng nhập$/ }));

    expect(onSubmit).toHaveBeenCalledWith({
      usernameOrEmail: 'kim',
      password: 'a-long-enough-password',
      totpCode: undefined,
      recoveryCode: 'ABCDE-FGHJK',
    });
  });
});

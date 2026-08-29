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
    });
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
});

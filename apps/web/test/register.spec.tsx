/**
 * `/register` — the screen whose absence made this a sign-in-only product:
 * the only way to get an account was `POST /auth/register` by hand.
 *
 * Three obligations are pinned here, one per describe:
 *  - the client refuses what the contract's Zod rules would refuse, in the
 *    active locale, WITHOUT spending a round trip;
 *  - a successful signup ends signed in — `register` mints no cookie (only
 *    `POST /auth/login` takes a `@Res`), so the page must chain the login
 *    itself, drop the stale `me` cache and land on `/`;
 *  - `username_taken` / `email_taken` land next to the field they are about,
 *    not in a general banner where a user has to guess which of five inputs
 *    is wrong.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('../src/api.js', () => ({ api: { POST: (...a: unknown[]) => post(...a) } }));

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { RegisterPage } = await import('../src/routes/register.js');

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RegisterPage />
    </QueryClientProvider>,
  );
}

/** Fills every field with something the contract accepts. */
async function fillValid(overrides: Partial<Record<string, string>> = {}): Promise<void> {
  const values = {
    username: 'kim.new-1',
    email: 'kim@example.com',
    displayName: 'Kim',
    password: 'a-long-enough-password',
    confirm: 'a-long-enough-password',
    ...overrides,
  };
  await userEvent.type(screen.getByLabelText(/^Tên đăng nhập$/), values.username!);
  await userEvent.type(screen.getByLabelText(/^Email$/), values.email!);
  await userEvent.type(screen.getByLabelText(/^Tên hiển thị$/), values.displayName!);
  await userEvent.type(screen.getByLabelText(/^Mật khẩu$/), values.password!);
  await userEvent.type(screen.getByLabelText(/^Nhập lại mật khẩu$/), values.confirm!);
}

function submit(): Promise<void> {
  return userEvent.click(screen.getByRole('button', { name: /^Đăng ký$/ }));
}

afterEach(() => {
  post.mockReset();
  navigate.mockReset();
});

describe('RegisterPage validation', () => {
  it('refuses a username shorter than the contract allows, without calling the API', async () => {
    wrap();
    await fillValid({ username: 'ab' });
    await submit();

    // `Username = z.string().min(3)` — the message is the client's own, in
    // the active locale, because no server answer exists to quote.
    expect(screen.getByLabelText(/^Tên đăng nhập$/)).toHaveAccessibleDescription(/Từ 3 đến 32 ký tự/);
    expect(screen.getByLabelText(/^Tên đăng nhập$/)).toHaveAttribute('aria-invalid', 'true');
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a username with characters the contract regex rejects', async () => {
    wrap();
    await fillValid({ username: 'kim nguyen' });
    await submit();
    expect(screen.getByLabelText(/^Tên đăng nhập$/)).toHaveAccessibleDescription(
      /chữ cái, chữ số, dấu chấm/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a password under ten characters — the register rule, not the reset rule', async () => {
    wrap();
    // Nine characters: `Password` is `.min(10)`. A page that copied
    // `ResetPasswordRequest`'s `.min(12)` would also refuse an honest
    // eleven-character password the server would have accepted, so the
    // boundary is asserted from BOTH sides below.
    await fillValid({ password: 'nine-char', confirm: 'nine-char' });
    await submit();
    expect(screen.getByLabelText(/^Mật khẩu$/)).toHaveAccessibleDescription(/Ít nhất 10 ký tự/);
    expect(post).not.toHaveBeenCalled();
  });

  it('accepts exactly ten characters', async () => {
    post.mockResolvedValue({ error: undefined, data: {} });
    wrap();
    await fillValid({ password: '0123456789', confirm: '0123456789' });
    await submit();
    expect(post).toHaveBeenCalled();
  });

  it('refuses a confirmation that does not match', async () => {
    wrap();
    await fillValid({ confirm: 'a-different-password' });
    await submit();
    expect(screen.getByLabelText(/^Nhập lại mật khẩu$/)).toHaveAccessibleDescription(
      /Hai mật khẩu không khớp/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses an address that is not one', async () => {
    wrap();
    await fillValid({ email: 'not-an-address' });
    await submit();
    expect(screen.getByLabelText(/^Email$/)).toHaveAccessibleDescription(/không giống một địa chỉ email/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('RegisterPage on success', () => {
  it('registers, signs in with the same credentials, and lands on the home page', async () => {
    post.mockResolvedValue({ error: undefined, data: {} });
    wrap();
    await fillValid();
    await submit();

    expect(post).toHaveBeenNthCalledWith(1, '/auth/register', {
      body: {
        username: 'kim.new-1',
        email: 'kim@example.com',
        displayName: 'Kim',
        password: 'a-long-enough-password',
      },
    });
    // `register` answers 201 + the user, and NO session cookie. Without this
    // second call the new account lands on `/` signed out, staring at the
    // sign-in form it just filled a longer version of.
    expect(post).toHaveBeenNthCalledWith(2, '/auth/login', {
      body: { usernameOrEmail: 'kim.new-1', password: 'a-long-enough-password' },
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it('says a confirmation mail is on its way', async () => {
    post.mockResolvedValue({ error: undefined, data: {} });
    wrap();
    await fillValid();
    await submit();
    // Best-effort in the controller (a mailer outage does not fail the
    // signup), so the wording promises nothing about arrival.
    expect(await screen.findByRole('status')).toHaveTextContent(/liên kết xác nhận/);
  });
});

describe('RegisterPage on a server refusal', () => {
  it('puts email_taken next to the email field and never signs in', async () => {
    post.mockResolvedValue({
      error: { code: 'email_taken', detail: 'That email is already registered.' },
    });
    wrap();
    await fillValid();
    await submit();

    expect(screen.getByLabelText(/^Email$/)).toHaveAccessibleDescription(/already registered/);
    expect(screen.getByLabelText(/^Email$/)).toHaveAttribute('aria-invalid', 'true');
    // The username is not the field at fault and must not be marked as one.
    expect(screen.getByLabelText(/^Tên đăng nhập$/)).not.toHaveAttribute('aria-invalid', 'true');
    expect(post).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('puts username_taken next to the username field', async () => {
    post.mockResolvedValue({
      error: { code: 'username_taken', detail: 'That username is already registered.' },
    });
    wrap();
    await fillValid();
    await submit();
    expect(screen.getByLabelText(/^Tên đăng nhập$/)).toHaveAccessibleDescription(/already registered/);
    expect(screen.getByLabelText(/^Email$/)).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('shows an unattributable refusal as a banner rather than guessing a field', async () => {
    post.mockResolvedValue({ error: { code: 'validation_failed', detail: 'Nope.' } });
    wrap();
    await fillValid();
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Nope.');
  });

  it('surfaces a connection failure instead of staying on Đang xử lý…', async () => {
    // openapi-fetch RETHROWS network-level failures rather than resolving
    // them to `{ error }` — see submit.tsx.
    post.mockRejectedValue(new TypeError('fetch failed'));
    wrap();
    await fillValid();
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không kết nối được máy chủ/);
    expect(screen.getByRole('button', { name: /^Đăng ký$/ })).toBeEnabled();
  });

  it('does not loop when the account was created but the sign-in that follows fails', async () => {
    post
      .mockResolvedValueOnce({ error: undefined, data: {} })
      .mockResolvedValueOnce({ error: { code: 'invalid_credentials', detail: 'Nope.' } });
    wrap();
    await fillValid();
    await submit();

    expect(post).toHaveBeenCalledTimes(2);
    // The account exists; sending them to `/` signed out would hide that.
    expect(navigate).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Nope.');
  });
});

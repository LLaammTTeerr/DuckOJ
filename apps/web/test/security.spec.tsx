import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    DELETE: (...a: unknown[]) => del(...a),
  },
}));

const { SecurityPage } = await import('../src/routes/security.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const OTPAUTH = 'otpauth://totp/DuckOJ:7?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=DuckOJ';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** `GET /auth/me` answering with 2FA off / on. */
function meIs(totpEnabled: boolean) {
  return { data: { id: 7, username: 'kim', displayName: 'Kim', globalRole: 'user', totpEnabled } };
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
  vi.restoreAllMocks();
});

describe('SecurityPage status', () => {
  it('reads whether 2FA is on from GET /auth/me', async () => {
    get.mockResolvedValue(meIs(false));
    wrap(<SecurityPage />);
    expect(await screen.findByRole('status')).toHaveTextContent(/not enabled/i);
    expect(screen.getByRole('button', { name: /enable/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull();
  });

  it('offers Disable, and only Disable, once 2FA is on', async () => {
    get.mockResolvedValue(meIs(true));
    wrap(<SecurityPage />);
    expect(await screen.findByRole('status')).toHaveTextContent(/is on for this account/i);
    expect(screen.getByRole('button', { name: /disable/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^enable$/i })).toBeNull();
  });

  // `fetchMe` maps the signed-out 401 to null. A TOKEN-authed viewer is a
  // different case: `GET /auth/me` answers with a user, the buttons render,
  // and the API's 403 `session_required` surfaces through `err.detail` on
  // click — the same way `/account/tokens` handles it.
  it('tells a viewer with no session to sign in with one', async () => {
    get.mockResolvedValue({ data: undefined });
    wrap(<SecurityPage />);
    expect(await screen.findByText(/sign in .*session, not a token/i)).toBeInTheDocument();
  });
});

describe('SecurityPage enrolment', () => {
  it('begins enrolment, then shows the secret as text AND as a scannable QR', async () => {
    get.mockResolvedValue(meIs(false));
    post.mockResolvedValue({ data: { secret: SECRET, otpauthUrl: OTPAUTH } });
    wrap(<SecurityPage />);

    await userEvent.click(await screen.findByRole('button', { name: /enable/i }));
    expect(post).toHaveBeenCalledWith('/auth/totp/begin');

    // The secret in a <code> block: the QR is a convenience, and a viewer
    // whose camera or renderer fails must still be able to enrol by typing.
    const code = await screen.findByText(SECRET);
    expect(code.tagName).toBe('CODE');
    expect(screen.getByRole('img', { name: /qr code/i })).toBeInTheDocument();
  });

  it('confirms with the six-digit code and refreshes the session status', async () => {
    // The server is the source of truth for `totpEnabled`: this page holds no
    // second copy, so confirming must invalidate `['me']` and the refetch is
    // what flips the status. A mock that stayed `false` forever would let a
    // page that merely set local state pass.
    let enabled = false;
    get.mockImplementation(() => Promise.resolve(meIs(enabled)));
    post.mockResolvedValueOnce({ data: { secret: SECRET, otpauthUrl: OTPAUTH } });
    post.mockImplementationOnce(() => {
      enabled = true;
      return Promise.resolve({ data: undefined, error: undefined });
    });
    wrap(<SecurityPage />);

    await userEvent.click(await screen.findByRole('button', { name: /enable/i }));
    await userEvent.type(await screen.findByLabelText(/six-digit code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(post).toHaveBeenLastCalledWith('/auth/totp/confirm', { body: { code: '123456' } });
    expect(await screen.findByRole('status')).toHaveTextContent(/is on for this account/i);
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it('surfaces a rejected enrolment code and keeps the secret on screen', async () => {
    get.mockResolvedValue(meIs(false));
    post.mockResolvedValueOnce({ data: { secret: SECRET, otpauthUrl: OTPAUTH } });
    post.mockResolvedValueOnce({
      error: { code: 'invalid_totp_enrolment_code', detail: 'That code is not valid.' },
    });
    wrap(<SecurityPage />);

    await userEvent.click(await screen.findByRole('button', { name: /enable/i }));
    await userEvent.type(await screen.findByLabelText(/six-digit code/i), '000000');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/i);
    // Still enrolling — the pending secret is unchanged server-side, so
    // sending the viewer back to the start would make them re-scan for nothing.
    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it('rejects a non-six-digit code without calling the API', async () => {
    get.mockResolvedValue(meIs(false));
    post.mockResolvedValueOnce({ data: { secret: SECRET, otpauthUrl: OTPAUTH } });
    wrap(<SecurityPage />);

    await userEvent.click(await screen.findByRole('button', { name: /enable/i }));
    await userEvent.type(await screen.findByLabelText(/six-digit code/i), '123');
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('SecurityPage disable', () => {
  it('asks for confirmation and does nothing when the viewer backs out', async () => {
    get.mockResolvedValue(meIs(true));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    wrap(<SecurityPage />);

    await userEvent.click(await screen.findByRole('button', { name: /disable/i }));
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes the credential once confirmed', async () => {
    get.mockResolvedValue(meIs(true));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    del.mockResolvedValue({ error: undefined });
    wrap(<SecurityPage />);

    await userEvent.click(await screen.findByRole('button', { name: /disable/i }));
    expect(del).toHaveBeenCalledWith('/auth/totp');
  });
});

describe('SecurityPage transport safety', () => {
  it('disables Enable while begin is in flight', async () => {
    get.mockResolvedValue(meIs(false));
    let resolve!: (value: unknown) => void;
    post.mockImplementation(() => new Promise((r) => { resolve = r; }));
    wrap(<SecurityPage />);

    const button = await screen.findByRole('button', { name: /enable/i });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    resolve({ data: { secret: SECRET, otpauthUrl: OTPAUTH } });
    await screen.findByText(SECRET);
  });

  it('surfaces a connection message and re-enables the button when the network fails', async () => {
    get.mockResolvedValue(meIs(false));
    post.mockRejectedValue(new TypeError('fetch failed'));
    wrap(<SecurityPage />);

    await userEvent.click(await screen.findByRole('button', { name: /enable/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i);
    expect(screen.getByRole('button', { name: /enable/i })).toBeEnabled();
  });
});

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

const { TokensPage } = await import('../src/routes/tokens.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
});

describe('TokensPage', () => {
  it('shows the minted token once, with the copy-now warning', async () => {
    get.mockResolvedValue({ data: [] });
    post.mockResolvedValue({ data: { id: 1, token: 'duckoj_secret_abc' } });
    wrap(<TokensPage />);

    await userEvent.type(await screen.findByLabelText(/^Tên$/), 'laptop-cli');
    await userEvent.click(screen.getByRole('button', { name: /^Tạo mã$/ }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('duckoj_secret_abc');
    expect(status).toHaveTextContent(/sẽ không hiện lại lần nữa/);
  });

  it('every contract scope is offered — the list cannot silently drift', async () => {
    const { SCOPES } = await import('@duckoj/contracts');
    get.mockResolvedValue({ data: [] });
    wrap(<TokensPage />);
    await screen.findByRole('heading', { name: /^Tạo mới$/ });
    for (const scope of SCOPES) {
      expect(screen.getByLabelText(scope)).toBeInTheDocument();
    }
  });

  it('revokes through the API and tells a token-authed viewer to use a session', async () => {
    get.mockResolvedValueOnce({
      data: [
        { id: 3, name: 'old', scopes: ['problems:read'], lastUsedAt: null, expiresAt: null, createdAt: '2026-01-01T00:00:00Z' },
      ],
    });
    get.mockResolvedValue({ data: [] });
    del.mockResolvedValue({ data: {} });
    wrap(<TokensPage />);
    await userEvent.click(await screen.findByRole('button', { name: /^Thu hồi$/ }));
    expect(del).toHaveBeenCalledWith('/auth/tokens/{id}', { params: { path: { id: 3 } } });

    get.mockReset();
    get.mockResolvedValue({ data: undefined });
    wrap(<TokensPage />);
    expect(await screen.findByText(/không phải bằng mã truy cập/)).toBeInTheDocument();
  });
});

describe('TokensPage transport safety', () => {
  it('disables Create while the request is in flight', async () => {
    get.mockResolvedValue({ data: [] });
    let resolve!: (value: unknown) => void;
    post.mockImplementation(() => new Promise((r) => { resolve = r; }));
    wrap(<TokensPage />);
    await userEvent.type(await screen.findByLabelText(/^Tên$/), 'laptop-cli');
    await userEvent.click(screen.getByRole('button', { name: /^Tạo mã$/ }));
    // The NAME changes while it is in flight (D148): a button that still
    // reads "Tạo mã" and does nothing is indistinguishable, on a slow link,
    // from a click nothing heard. Disabled is still the half that makes a
    // second press impossible.
    expect(screen.getByRole('button', { name: /Đang tạo/ })).toBeDisabled();
    resolve({ data: { id: 1, token: 'duckoj_secret_abc' } });
    await screen.findByRole('status');
  });

  it('surfaces a connection message and re-enables Create when the network fails', async () => {
    get.mockResolvedValue({ data: [] });
    post.mockRejectedValue(new TypeError('fetch failed'));
    wrap(<TokensPage />);
    await userEvent.type(await screen.findByLabelText(/^Tên$/), 'laptop-cli');
    await userEvent.click(screen.getByRole('button', { name: /^Tạo mã$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không kết nối được máy chủ/);
    expect(screen.getByRole('button', { name: /^Tạo mã$/ })).toBeEnabled();
  });
});

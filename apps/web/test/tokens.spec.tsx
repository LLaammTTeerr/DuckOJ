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

    await userEvent.type(await screen.findByLabelText(/name/i), 'laptop-cli');
    await userEvent.click(screen.getByRole('button', { name: /create token/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('duckoj_secret_abc');
    expect(status).toHaveTextContent(/will not be shown again/i);
  });

  it('every contract scope is offered — the list cannot silently drift', async () => {
    const { SCOPES } = await import('@duckoj/contracts');
    get.mockResolvedValue({ data: [] });
    wrap(<TokensPage />);
    await screen.findByRole('heading', { name: /create/i });
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
    await userEvent.click(await screen.findByRole('button', { name: /revoke/i }));
    expect(del).toHaveBeenCalledWith('/auth/tokens/{id}', { params: { path: { id: 3 } } });

    get.mockReset();
    get.mockResolvedValue({ data: undefined });
    wrap(<TokensPage />);
    expect(await screen.findByText(/with a session, not a token/i)).toBeInTheDocument();
  });
});

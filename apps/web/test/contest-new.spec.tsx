import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const navigate = vi.fn();
vi.mock('../src/api.js', () => ({ api: { POST: (...a: unknown[]) => post(...a) } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => navigate,
}));

const { ContestNewPage } = await import('../src/routes/contest-new.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  post.mockReset();
  navigate.mockReset();
});

async function fillBasics() {
  await userEvent.type(screen.getByLabelText(/^key/i), 'spring');
  await userEvent.type(screen.getByLabelText(/^name/i), 'Spring Open');
  // datetime-local inputs: type a full local stamp.
  await userEvent.type(screen.getByLabelText(/starts/i), '2026-09-01T09:00');
  await userEvent.type(screen.getByLabelText(/ends/i), '2026-09-01T14:00');
}

describe('ContestNewPage', () => {
  it('sends instants, not zoneless strings, and navigates to the created key', async () => {
    post.mockResolvedValue({ data: { key: 'spring' } });
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.type(screen.getByLabelText(/problem 1 code/i), 'aplusb');
    await userEvent.click(screen.getByRole('button', { name: /create contest/i }));

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
    await userEvent.type(screen.getByLabelText(/problem 1 code/i), 'aplusb');
    await userEvent.clear(screen.getByLabelText(/problem 1 points/i));
    await userEvent.type(screen.getByLabelText(/problem 1 points/i), 'lots');
    await userEvent.click(screen.getByRole('button', { name: /create contest/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/points/i);
    expect(post).not.toHaveBeenCalled();
  });

  it('a blank problem row is dropped, not sent as an empty code', async () => {
    post.mockResolvedValue({ data: { key: 'spring' } });
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.click(screen.getByRole('button', { name: /create contest/i }));
    const body = (post.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body;
    expect(body.problems).toEqual([]);
  });

  it('surfaces the API detail on refusal', async () => {
    post.mockResolvedValue({ error: { detail: 'That contest key is already taken.' } });
    wrap(<ContestNewPage />);
    await fillBasics();
    await userEvent.click(screen.getByRole('button', { name: /create contest/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already taken/i);
    expect(navigate).not.toHaveBeenCalled();
  });
});

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({ api: { GET: (...a: unknown[]) => get(...a) } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { UserPage } = await import('../src/routes/user.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const PROFILE = {
  id: 1,
  username: 'kim',
  displayName: 'Kim',
  globalRole: 'user',
  country: null,
  rating: 1520,
  maxRating: 1580,
  createdAt: '2026-01-01T00:00:00Z',
  about: null,
  stats: { solvedCount: 3, points: 250, submissionCount: 9 },
};

afterEach(() => get.mockReset());

describe('UserPage', () => {
  it('shows the statistics and the peak beside the current rating', async () => {
    get.mockImplementation((path: string) =>
      path === '/users/{username}' ? Promise.resolve({ data: PROFILE }) : Promise.resolve({ data: [] }),
    );
    wrap(<UserPage username="kim" />);

    expect(await screen.findByRole('heading', { name: 'Kim' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /problems solved/i })).toHaveTextContent('3');
    expect(screen.getByRole('row', { name: /points/i })).toHaveTextContent('250');
    // The peak only appears when it differs from the current rating —
    // "1520 (peak 1520)" is noise.
    // The D6 placeholder band table: 1520 sits in the 1400-1599 band.
    expect(screen.getByRole('row', { name: /rating/i })).toHaveTextContent(
      'Specialist \u00b7 1520 (peak 1580)',
    );
  });

  it('says unrated rather than showing a number nobody earned', async () => {
    get.mockImplementation((path: string) =>
      path === '/users/{username}'
        ? Promise.resolve({ data: { ...PROFILE, rating: null, maxRating: null } })
        : Promise.resolve({ data: [] }),
    );
    wrap(<UserPage username="kim" />);
    expect(await screen.findByRole('row', { name: /rating/i })).toHaveTextContent('unrated');
    expect(screen.getByText(/not rated yet/i)).toBeInTheDocument();
  });

  it('signs the rating change so a column of them scans', async () => {
    get.mockImplementation((path: string) =>
      path === '/users/{username}'
        ? Promise.resolve({ data: PROFILE })
        : Promise.resolve({
            data: [
              { contestKey: 'a', contestName: 'Alpha', endTime: '2026-02-01T00:00:00Z', rank: 1, ratingBefore: 1500, ratingAfter: 1580, delta: 80 },
              { contestKey: 'b', contestName: 'Beta', endTime: '2026-03-01T00:00:00Z', rank: 9, ratingBefore: 1580, ratingAfter: 1520, delta: -60 },
            ],
          }),
    );
    wrap(<UserPage username="kim" />);

    expect(await screen.findByRole('row', { name: /alpha/i })).toHaveTextContent('+80');
    expect(screen.getByRole('row', { name: /beta/i })).toHaveTextContent('-60');
  });

  it('reports an unknown user rather than rendering an empty profile', async () => {
    get.mockResolvedValue({ error: { detail: 'No such user.' } });
    wrap(<UserPage username="ghost" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no such user/i);
  });
});

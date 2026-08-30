import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../src/api.js', () => ({ api: { GET: (...a: unknown[]) => get(...a) } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { UserPage } = await import('../src/routes/user.js');
const { LocaleProvider } = await import('../src/i18n/index.js');
const { RANK_BANDS } = await import('@duckoj/glicko2');

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
    expect(screen.getByRole('row', { name: /Số bài đã giải/ })).toHaveTextContent('3');
    expect(screen.getByRole('row', { name: /^Điểm/ })).toHaveTextContent('250');
    // The peak only appears when it differs from the current rating —
    // "1520 (cao nhất 1520)" is noise. The band title is data from
    // `packages/glicko2` (D46), not a UI string, and it carries BOTH
    // locales on the row: the Vietnamese default renders the Vietnamese
    // half. 1520 sits in the 1400–1599 band.
    expect(screen.getByRole('row', { name: /^Rating/ })).toHaveTextContent(
      'Chuyên gia \u00b7 1520 (cao nhất 1580)',
    );
  });

  // D46 — the band gets a colour, from the muted rank scale app.css owns.
  // The class is the band's own key, so a renamed band cannot silently keep
  // another band's colour.
  it('marks the title with its band class so the rank scale can colour it', async () => {
    get.mockImplementation((path: string) =>
      path === '/users/{username}' ? Promise.resolve({ data: PROFILE }) : Promise.resolve({ data: [] }),
    );
    wrap(<UserPage username="kim" />);
    const title = await screen.findByText('Chuyên gia');
    expect(title).toHaveClass('rank', 'specialist');
  });

  it('renders the English half of the same row under the English locale', async () => {
    get.mockImplementation((path: string) =>
      path === '/users/{username}' ? Promise.resolve({ data: PROFILE }) : Promise.resolve({ data: [] }),
    );
    wrap(
      <LocaleProvider initialLocale="en">
        <UserPage username="kim" />
      </LocaleProvider>,
    );
    expect(await screen.findByText('Specialist')).toBeInTheDocument();
  });

  it('says unrated rather than showing a number nobody earned', async () => {
    get.mockImplementation((path: string) =>
      path === '/users/{username}'
        ? Promise.resolve({ data: { ...PROFILE, rating: null, maxRating: null } })
        : Promise.resolve({ data: [] }),
    );
    wrap(<UserPage username="kim" />);
    expect(await screen.findByRole('row', { name: /^Rating/ })).toHaveTextContent('chưa xếp hạng');
    expect(screen.getByText(/Chưa được xếp hạng/)).toBeInTheDocument();
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
    // The server's own `detail` wins over the local fallback and is shown
    // verbatim — never translated (see i18n/en.ts's header).
    expect(await screen.findByRole('alert')).toHaveTextContent(/No such user/i);
  });
});

/**
 * The band table and the stylesheet are two files that have to agree: the
 * key is the CSS modifier class, so a band added or renamed in
 * `packages/glicko2` and not in `app.css` renders in the plain foreground
 * colour and nothing says so. This is the only place that can notice.
 */
describe('the rank scale', () => {
  // `process.cwd()` is `apps/web` under this package's vitest root; an
  // `import.meta.url` file URL is not available through Vite's transform.
  const css = readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8');

  it('gives every band in the table its own colour rule', () => {
    for (const band of RANK_BANDS) {
      expect(css).toContain(`.rank.${band.key} {`);
      expect(css).toContain(`--rank-${band.key}:`);
    }
  });

  it('defines the scale in both palettes, not just the light one', () => {
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    for (const band of RANK_BANDS) {
      expect(dark).toContain(`--rank-${band.key}:`);
    }
  });
});

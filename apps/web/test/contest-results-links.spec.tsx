import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { ContestPage } = await import('../src/routes/contests.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const NO_CLARIFICATIONS = { data: { items: [] } };

/**
 * A contest that has ENDED, run by the viewer — the one state in which D71's
 * exports are offered.
 */
const FINISHED = {
  key: 'spring',
  name: 'Spring Open',
  format: 'icpc',
  startTime: new Date(Date.now() - 7_200_000).toISOString(),
  endTime: new Date(Date.now() - 3_600_000).toISOString(),
  orgs: [],
  canEdit: true,
  problems: [{ code: 'aplusb', name: 'A plus B', label: 'A', points: 100 }],
};

function mockContest(overrides: Record<string, unknown> = {}): void {
  get.mockImplementation((path: string) => {
    if (path === '/contests/{key}/clarifications') return Promise.resolve(NO_CLARIFICATIONS);
    if (path === '/contests/{key}/similarity') return Promise.resolve({ data: { run: null } });
    if (path === '/contests/{key}') return Promise.resolve({ data: { ...FINISHED, ...overrides } });
    return Promise.resolve({ data: undefined });
  });
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
});

/**
 * `GET /contests/{key}/certificates.pdf` shipped with F12 and NOTHING linked
 * it: the results sheet had two links and the award nobody can reproduce by
 * hand had none, so the one document a school prints was reachable only by
 * typing a URL into the bar. These three cases stand together — the
 * certificates link is offered on exactly the terms the other two are, and
 * withheld on exactly the terms they are.
 */
describe('the contest page’s organiser exports', () => {
  it('links results and certificates once the contest has finished', async () => {
    mockContest();
    wrap(<ContestPage contestKey="spring" />);

    const csv = await screen.findByRole('link', { name: 'Kết quả (CSV)' });
    expect(csv).toHaveAttribute('href', '/api/v1/contests/spring/results.csv');
    expect(screen.getByRole('link', { name: 'Kết quả (PDF)' })).toHaveAttribute(
      'href',
      '/api/v1/contests/spring/results.pdf',
    );
    // `top` is REQUIRED — `CertificatesQuery` refuses a request carrying
    // neither `top` nor `username` — and D74 makes it a bound on the RANK.
    // Three is the podium the box opens on.
    expect(screen.getByRole('link', { name: 'Giấy chứng nhận (PDF)' })).toHaveAttribute(
      'href',
      '/api/v1/contests/spring/certificates.pdf?top=3',
    );
  });

  it('lets the organiser choose how deep the awards go, and never addresses a 422', async () => {
    mockContest();
    wrap(<ContestPage contestKey="spring" />);

    const box = await screen.findByLabelText('Cấp tới hạng');
    await userEvent.clear(box);
    await userEvent.type(box, '25');
    expect(screen.getByRole('link', { name: 'Giấy chứng nhận (PDF)' })).toHaveAttribute(
      'href',
      '/api/v1/contests/spring/certificates.pdf?top=25',
    );

    // The box is a hint, not a guarantee: a reader can still empty it or
    // type past the contract's ceiling, and the href must stay inside
    // 1…1000 either way rather than becoming a link that only 422s.
    await userEvent.clear(box);
    expect(screen.getByRole('link', { name: 'Giấy chứng nhận (PDF)' })).toHaveAttribute(
      'href',
      '/api/v1/contests/spring/certificates.pdf?top=1',
    );
    await userEvent.type(box, '9999');
    expect(screen.getByRole('link', { name: 'Giấy chứng nhận (PDF)' })).toHaveAttribute(
      'href',
      '/api/v1/contests/spring/certificates.pdf?top=1000',
    );
  });

  it('offers none of them to a competitor', async () => {
    mockContest({ canEdit: false });
    wrap(<ContestPage contestKey="spring" />);

    // The booklet is everyone's, so wait on it rather than on an absence.
    await screen.findByRole('link', { name: 'Tải đề (PDF)' });
    expect(screen.queryByRole('link', { name: 'Kết quả (CSV)' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Giấy chứng nhận (PDF)' })).toBeNull();
    expect(screen.queryByLabelText('Cấp tới hạng')).toBeNull();
  });

  it('offers none of them while the contest is still running', async () => {
    mockContest({
      startTime: new Date(Date.now() - 60_000).toISOString(),
      endTime: new Date(Date.now() + 3_600_000).toISOString(),
    });
    wrap(<ContestPage contestKey="spring" />);

    await screen.findByRole('link', { name: 'Tải đề (PDF)' });
    expect(screen.queryByRole('link', { name: 'Kết quả (CSV)' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Giấy chứng nhận (PDF)' })).toBeNull();
  });
});

/**
 * The seat slips (D129) — the one organiser export offered BEFORE the gun.
 *
 * D71's three links wait for `phase === 'finished'`, because printing a board
 * that is still moving invites a wrong sheet. A seat slip is the opposite
 * artefact: it is cut up the night before, so gating it on the end of the
 * contest would ship a feature nobody could ever use in time.
 */
describe('the contest page’s seat slips', () => {
  it('offers the organiser the slips before the contest has started', async () => {
    mockContest({
      startTime: new Date(Date.now() + 3_600_000).toISOString(),
      endTime: new Date(Date.now() + 7_200_000).toISOString(),
    });
    wrap(<ContestPage contestKey="spring" />);

    const slips = await screen.findByRole('link', { name: 'Phiếu dự thi (PDF)' });
    expect(slips).toHaveAttribute('href', '/api/v1/contests/spring/seats.pdf');
    // …and the results exports are still withheld, as D71 has them.
    expect(screen.queryByRole('link', { name: 'Kết quả (CSV)' })).toBeNull();
  });

  it('still offers them once the contest is over, beside the results', async () => {
    mockContest();
    wrap(<ContestPage contestKey="spring" />);

    await screen.findByRole('link', { name: 'Kết quả (CSV)' });
    expect(screen.getByRole('link', { name: 'Phiếu dự thi (PDF)' })).toHaveAttribute(
      'href',
      '/api/v1/contests/spring/seats.pdf',
    );
  });

  it('never offers them to a competitor', async () => {
    mockContest({ canEdit: false });
    wrap(<ContestPage contestKey="spring" />);

    await screen.findByRole('link', { name: 'Tải đề (PDF)' });
    expect(screen.queryByRole('link', { name: 'Phiếu dự thi (PDF)' })).toBeNull();
  });
});

import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

// `api.js` is mocked, as it is in every spec here — it pulls in the real
// SDK. `ApiError` deliberately does NOT live there (see src/api-error.ts),
// so the policy under test can be exercised against the genuine type.
vi.mock('../src/api.js', () => ({ api: { GET: (...a: unknown[]) => get(...a) } }));

const { ApiError } = await import('../src/api-error.js');
const { createQueryClient, retryTransientOnly } = await import('../src/query.js');
const { UserPage } = await import('../src/routes/user.js');
const { OrgPage } = await import('../src/routes/orgs.js');
const { SubmissionPage } = await import('../src/routes/submission.js');
const { ContestPage, ScoreboardPage } = await import('../src/routes/contests.js');

afterEach(() => get.mockReset());

/** The REAL client the app ships (`main.tsx`), not a `retry: false` stub. */
function wrap(ui: React.ReactElement) {
  return render(<QueryClientProvider client={createQueryClient()}>{ui}</QueryClientProvider>);
}

function notFound() {
  return Promise.resolve({
    error: { detail: 'Không có mục này.', code: 'not_found' },
    response: new Response(null, { status: 404 }),
  });
}

describe('retryTransientOnly', () => {
  // Every other spec in this suite builds its client with `retry: false`, so
  // the shipped retry policy had no test at all — which is how a 404 came to
  // be retried three times with exponential backoff. Measured against the
  // live stack before the fix: /users/NOPE, /orgs/NOPE and /submissions/999999
  // each held "Đang tải…" on screen for ~7.4 s and fired four requests
  // (404@114ms, 404@1119ms, 404@3129ms, 404@7135ms).
  it('does not retry a 4xx — the answer will not change', () => {
    expect(retryTransientOnly(0, new ApiError(404, 'no'))).toBe(false);
    expect(retryTransientOnly(0, new ApiError(401, 'no'))).toBe(false);
    expect(retryTransientOnly(0, new ApiError(422, 'no'))).toBe(false);
  });

  it('still retries a 5xx and a network failure — those are transient', () => {
    expect(retryTransientOnly(0, new ApiError(500, 'boom'))).toBe(true);
    expect(retryTransientOnly(0, new ApiError(503, 'boom'))).toBe(true);
    expect(retryTransientOnly(0, new TypeError('Failed to fetch'))).toBe(true);
  });

  it('gives up after three transient attempts rather than hammering forever', () => {
    expect(retryTransientOnly(2, new ApiError(500, 'boom'))).toBe(true);
    expect(retryTransientOnly(3, new ApiError(500, 'boom'))).toBe(false);
  });
});

describe('a 404 detail page under the shipped query client', () => {
  it('says "no such user" at once instead of spinning on Loading…', async () => {
    get.mockImplementation(notFound);
    wrap(<UserPage username="nope" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không có mục này.');
  });

  it('says "no such organization" at once', async () => {
    get.mockImplementation(notFound);
    wrap(<OrgPage slug="nope" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không có mục này.');
  });

  it('says "no such submission" at once', async () => {
    get.mockImplementation(notFound);
    wrap(<SubmissionPage id={999999} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không có mục này.');
  });

  // The two that made the first pass at this incomplete: /contests/NOPE and
  // its scoreboard were still measured at 7401 ms and 7381 ms on a build
  // that had already fixed the profile, org and submission pages, because
  // their queryFns still threw a status-less Error.
  it('says "no such contest" at once', async () => {
    get.mockImplementation(notFound);
    wrap(<ContestPage contestKey="nope" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không có mục này.');
  });

  it('says so on the scoreboard too', async () => {
    get.mockImplementation(notFound);
    wrap(<ScoreboardPage contestKey="nope" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không có mục này.');
  });
});

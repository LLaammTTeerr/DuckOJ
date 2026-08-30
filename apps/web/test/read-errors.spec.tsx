/**
 * Every read that used to swallow a failure, and what its screen says now.
 *
 * `openapi-fetch` RESOLVES on an HTTP error, so `const { data } = await
 * api.GET(…)` compiles, type-checks, passes review and turns every 500 into
 * `undefined` — which the next line's `?? []` or `?? null` renders as a fact
 * about the world. B-4 replaced these once; B-8 found nine still standing,
 * two of them written after B-4. This file is the reason a tenth would be
 * caught: each case asserts a failing read is DISTINGUISHABLE from the empty
 * answer it used to imitate.
 *
 * The two halves matter equally, and the second is the one a blanket "throw
 * on every error" would break: some of these reads have a status that
 * genuinely IS the answer (401 to a signed-out visitor, 404 for "you have not
 * joined"), and those must stay silent. So most cases here come in pairs.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const patch = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    DELETE: (...a: unknown[]) => del(...a),
    PATCH: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { read, ApiError } = await import('../src/api-error.js');
// `await import` gives back the CLASS, so `ApiError` is a value here and not
// a type. This alias is the type side of the same thing.
type ApiErrorInstance = InstanceType<typeof ApiError>;
const { Home } = await import('../src/routes/index.js');
const { TokensPage } = await import('../src/routes/tokens.js');
const { notificationsQueryOptions } = await import('../src/routes/notifications.js');
const { tagsQueryOptions } = await import('../src/tags.js');
const { OrgPage } = await import('../src/routes/orgs.js');
const { ContestPage } = await import('../src/routes/contests.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** What `openapi-fetch` hands back for a failed request. */
function failure(status: number, detail?: string) {
  return { error: { detail, code: 'boom' }, response: { status } };
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
  patch.mockReset();
});

describe('read()', () => {
  it('returns the body when the request succeeded', () => {
    expect(read({ data: { n: 1 }, response: { status: 200 } }, 'x')).toEqual({ n: 1 });
  });

  it('throws an ApiError that still carries the status', () => {
    // The status is the point. `src/query.ts` declines to retry a 4xx, so a
    // read that loses it costs four requests and seven seconds of "Loading…"
    // to reach an answer the server gave immediately.
    expect(() => read(failure(500, 'nope'), 'fallback')).toThrow(ApiError);
    try {
      read(failure(404), 'fallback');
    } catch (error) {
      expect((error as ApiErrorInstance).status).toBe(404);
      expect((error as ApiErrorInstance).message).toBe('fallback');
    }
  });

  it('returns null, not a throw, for a status the caller called absent', () => {
    expect(read(failure(401), 'x', [401])).toBeNull();
    expect(() => read(failure(403), 'x', [401])).toThrow(ApiError);
  });

  it('treats a 4xx with no decodable body as a failure', () => {
    // openapi-fetch leaves `error` undefined when there is no body to decode,
    // so a check on `error` alone lets the failure through as `null` — the
    // exact swallow, reintroduced one layer down.
    expect(() => read({ response: { status: 500 } }, 'x')).toThrow(ApiError);
  });

  it('does not mistake an empty 204 for a failure', () => {
    expect(read({ response: { status: 204 } }, 'x')).toBeNull();
  });
});

describe('Home — GET /auth/me', () => {
  it('says "not signed in" for a 401, which is an answer and not a failure', async () => {
    get.mockResolvedValue(failure(401));
    wrap(<Home />);
    expect(await screen.findByText(/Chưa đăng nhập/)).toBeInTheDocument();
  });

  it('does not tell a signed-in reader they are signed out when the read fails', async () => {
    get.mockResolvedValue(failure(500));
    wrap(<Home />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/Chưa đăng nhập/)).not.toBeInTheDocument();
  });
});

describe('TokensPage — GET /auth/tokens', () => {
  it('does not tell a session-authed reader to sign in with a session', async () => {
    // The null branch of this page renders "sign in with a session, not an
    // access token". A swallowed 500 rendered exactly that, so the reader was
    // told to do the thing they had already done.
    get.mockResolvedValue(failure(500));
    wrap(<TokensPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Không tải được danh sách mã truy cập/);
    expect(screen.queryByText(/không phải bằng mã truy cập/)).not.toBeInTheDocument();
  });
});

describe('tagsQueryOptions — GET /tags', () => {
  it('fails loudly rather than reporting a judge with no tags', async () => {
    // Silent, this empties the problem list's filter bar and every checkbox
    // on the edit form: a screen that looks complete and offers nothing.
    get.mockResolvedValue(failure(500));
    await expect(tagsQueryOptions.queryFn()).rejects.toBeInstanceOf(ApiError);
  });

  it('still returns the vocabulary when the read succeeds', async () => {
    get.mockResolvedValue({ data: { items: [{ slug: 'dp', nameVi: 'QHĐ', nameEn: 'DP' }] } });
    await expect(tagsQueryOptions.queryFn()).resolves.toHaveLength(1);
  });
});

describe('notificationsQueryOptions — GET /notifications', () => {
  it('stays silent for the signed-out and token-session states', async () => {
    get.mockResolvedValue(failure(401));
    await expect(notificationsQueryOptions.queryFn()).resolves.toBeNull();
    get.mockResolvedValue(failure(403));
    await expect(notificationsQueryOptions.queryFn()).resolves.toBeNull();
  });

  it('does not render a 500 as an empty inbox and a bell reading zero', async () => {
    get.mockResolvedValue(failure(500));
    await expect(notificationsQueryOptions.queryFn()).rejects.toBeInstanceOf(ApiError);
  });
});

/** The org page's two sub-reads, both rendered inside `OrgPage`. */
function serveOrg(overrides: (path: string) => unknown | undefined) {
  get.mockImplementation((path: string) => {
    const override = overrides(path);
    if (override !== undefined) return Promise.resolve(override);
    if (path === '/auth/me') return Promise.resolve({ data: { username: 'owner-person', displayName: 'Owner' } });
    if (path === '/orgs/{slug}')
      return Promise.resolve({
        data: {
          id: 1,
          slug: 'hanoi',
          name: 'Hanoi CS',
          about: null,
          visibility: 'public',
          joinPolicy: 'request',
          createdAt: '2026-01-01T00:00:00Z',
          myRole: 'owner',
        },
      });
    if (path === '/orgs/{slug}/members')
      return Promise.resolve({
        data: { items: [{ username: 'owner-person', role: 'owner', joinedAt: '2026-01-01T00:00:00Z' }], nextCursor: null },
      });
    if (path === '/orgs/{slug}/requests') return Promise.resolve({ data: [] });
    return Promise.resolve({ data: { items: [] } });
  });
}

describe("OrgPage — the school's contests, GET /contests?org=", () => {
  it('says the list failed instead of showing a school that runs no contests', async () => {
    serveOrg((path) => (path === '/contests' ? failure(500) : undefined));
    wrap(<OrgPage slug="hanoi" />);
    // The roster still renders — a failed section must not take the page
    // down — but the section itself now says what happened.
    expect(await screen.findByText('Hanoi CS')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Không tải được danh sách kỳ thi/)).toBeInTheDocument();
    });
  });

  it('stays absent, not alarming, when the school genuinely runs none', async () => {
    serveOrg(() => undefined);
    wrap(<OrgPage slug="hanoi" />);
    expect(await screen.findByText('Hanoi CS')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/Không tải được danh sách kỳ thi/)).not.toBeInTheDocument();
    });
  });
});

describe('OrgPage — the join queue, GET /orgs/{slug}/requests', () => {
  it('does not show a decider an empty queue when the queue failed to load', async () => {
    serveOrg((path) => (path === '/orgs/{slug}/requests' ? failure(500) : undefined));
    wrap(<OrgPage slug="hanoi" />);
    expect(await screen.findByText('Hanoi CS')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Không tải được danh sách yêu cầu tham gia/)).toBeInTheDocument();
    });
  });
});

describe('ContestPage — GET /contests/{key}/me', () => {
  // The same shape contests.spec.tsx uses — a running contest with one
  // problem. The page reads `format` and `orgs`, so a trimmed fixture renders
  // nothing at all and every assertion below fails for the wrong reason.
  const RUNNING = {
    key: 'cup',
    name: 'Cup',
    format: 'icpc',
    startTime: new Date(Date.now() - 60_000).toISOString(),
    endTime: new Date(Date.now() + 3_600_000).toISOString(),
    orgs: [],
    problems: [{ code: 'aplusb', name: 'A plus B', label: 'A', points: 100 }],
  };

  function serveContest(participation: unknown) {
    get.mockImplementation((path: string) => {
      if (path === '/contests/{key}') return Promise.resolve({ data: RUNNING });
      if (path === '/contests/{key}/me') return Promise.resolve(participation);
      if (path === '/contests/{key}/clarifications') return Promise.resolve({ data: { items: [] } });
      if (path === '/auth/me') return Promise.resolve({ data: { username: 'hocsinh1', displayName: 'HS' } });
      return Promise.resolve({ data: undefined });
    });
  }

  it('offers Join on a 404, which is exactly what "you have not joined" is', async () => {
    serveContest(failure(404));
    wrap(<ContestPage contestKey="cup" />);
    expect(await screen.findByRole('button', { name: /Tham gia/ })).toBeInTheDocument();
  });

  it('does not offer Join to somebody already competing when the read fails', async () => {
    // The swallow's worst reading on this page: a 500 was indistinguishable
    // from "not joined", so a competitor mid-contest was shown the Join
    // button for a contest they were already in.
    serveContest(failure(500));
    wrap(<ContestPage contestKey="cup" />);
    await screen.findByText('Cup');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Tham gia/ })).not.toBeInTheDocument();
    });
  });
});

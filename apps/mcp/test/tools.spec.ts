/**
 * Every tool, against a doubled `fetch`: the request it makes, and the shape
 * of what it hands back.
 *
 * One `it` per tool rather than a table-driven loop, because the interesting
 * part of each is different — `problems_search` renames `tags` to the API's
 * `tag`, `problems_draft_put_file` must NOT send JSON, `problems_patch`
 * refuses an empty patch before it makes a request at all. A loop would pin
 * only the part they have in common, which is the part nothing gets wrong.
 */
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools.js';
import { ApiFailure } from '../src/errors.js';
import type { ToolSpec } from '../src/tool.js';
import { fakeContext, json, problem, stub, type Responder } from './harness.js';

function tool(name: string): ToolSpec {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no such tool: ${name}`);
  return found;
}

async function call(name: string, args: unknown, responder: Responder) {
  const stubbed = stub(responder);
  const outcome = await tool(name).run(stubbed.client, args, fakeContext());
  return { ...outcome, calls: stubbed.calls, last: stubbed.last() };
}

const PROBLEM_ROW = {
  id: 1,
  code: 'tong-hai-so',
  name: 'Tổng hai số',
  visibility: 'public',
  hasPublishedRevision: true,
  timeMs: 1000,
  memoryKb: 262144,
  testCount: 12,
  me: null,
  tags: [{ slug: 'implementation', nameVi: 'Cài đặt', nameEn: 'Implementation' }],
  difficulty: 1,
  attemptedCount: 4,
  solvedCount: 3,
};

const PROBLEM_DETAIL = {
  ...PROBLEM_ROW,
  statement: '# T\n\n## Ví dụ\n\n| Dữ liệu vào | Kết quả |\n| --- | --- |\n| `2 3` | `5` |\n',
  sourceAccess: 'solved',
  totalPoints: 100,
  checkerKind: 'wcmp',
  createdAt: '2026-01-01T00:00:00.000Z',
  members: [],
  orgSlugs: [],
  editorial: null,
  editorialAvailable: true,
};

const SUBMISSION_DETAIL = {
  id: 7,
  problemCode: 'tong-hai-so',
  languageKey: 'cpp17',
  source: 'int main(){}',
  state: 'done',
  verdict: 'WA',
  points: 40,
  maxPoints: 100,
  timeMs: 12,
  memoryKb: 3000,
  compileOutput: null,
  cases: [
    { groupIndex: 0, caseIndex: 0, verdict: 'AC', skipped: false, timeMs: 1, memoryKb: 2, points: 40, maxPoints: 40, feedback: null },
    { groupIndex: 1, caseIndex: 1, verdict: 'WA', skipped: false, timeMs: 2, memoryKb: 2, points: 0, maxPoints: 60, feedback: 'wrong answer on line 1' },
    { groupIndex: 1, caseIndex: 2, verdict: null, skipped: true, timeMs: 0, memoryKb: 0, points: 0, maxPoints: 0, feedback: null },
  ],
  contestKey: null,
  contestLabel: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  judgedAt: '2026-01-01T00:00:05.000Z',
  frozen: false,
  sourceHidden: false,
};

describe('problems_search', () => {
  it('sends every filter, and renames `tags` to the API\'s repeated `tag`', async () => {
    const result = await call(
      'problems_search',
      { q: 'tổng', tags: ['dp', 'graphs'], difficultyMin: 2, difficultyMax: 5, limit: 10 },
      () => json({ items: [PROBLEM_ROW], nextCursor: 'c2' }),
    );
    const url = new URL(result.last.url);
    expect(url.pathname).toBe('/api/v1/problems');
    expect(url.searchParams.get('q')).toBe('tổng');
    expect(url.searchParams.getAll('tag')).toEqual(['dp', 'graphs']);
    expect(url.searchParams.get('difficultyMin')).toBe('2');
    expect(url.searchParams.get('difficultyMax')).toBe('5');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(result.summary).toContain('more available');
  });

  it('sends no query at all when called with no arguments', async () => {
    const result = await call('problems_search', {}, () => json({ items: [], nextCursor: null }));
    expect(new URL(result.last.url).search).toBe('');
    expect(result.summary).toBe('0 problem(s)');
  });

  it('projects a row down to what a caller chooses by', async () => {
    const result = await call('problems_search', {}, () =>
      json({ items: [PROBLEM_ROW], nextCursor: null }),
    );
    expect(result.data).toEqual({
      items: [
        {
          code: 'tong-hai-so',
          name: 'Tổng hai số',
          difficulty: 1,
          tags: ['implementation'],
          timeMs: 1000,
          memoryKb: 262144,
          testCount: 12,
          solvedCount: 3,
          attemptedCount: 4,
          myVerdict: null,
        },
      ],
      nextCursor: null,
    });
  });
});

describe('problems_get', () => {
  /**
   * D94: the API's own `samples` win. The fixtures below deliberately make
   * the two disagree — the package's files carry a trailing newline and an
   * explanation, the statement's table carries neither — so a test that
   * passes cannot be reading the wrong one.
   */
  const API_SAMPLES = [
    { input: '2 3\n', output: '5\n', explanation: 'Cộng hai số.', truncated: false },
  ];

  it("prefers the API's samples, verbatim, over anything scraped out of the prose", async () => {
    const result = await call('problems_get', { code: 'tong-hai-so' }, () =>
      json({ ...PROBLEM_DETAIL, samples: API_SAMPLES }),
    );
    const data = result.data as { samples: { source: string; items: unknown[] } };
    expect(data.samples).toEqual({
      source: 'api',
      items: [{ input: '2 3\n', output: '5\n', note: 'Cộng hai số.' }],
    });
  });

  it('marks a truncated sample so an agent knows the file it has is not the whole file', async () => {
    const result = await call('problems_get', { code: 'p' }, () =>
      json({
        ...PROBLEM_DETAIL,
        samples: [{ input: 'x', output: 'y', explanation: null, truncated: true }],
      }),
    );
    const data = result.data as { samples: { items: Array<{ truncated?: boolean; note?: string }> } };
    expect(data.samples.items[0]).toEqual({ input: 'x', output: 'y', truncated: true });
  });

  it('falls back to the table when the API answers an empty list — an unreadable package, not "no samples"', async () => {
    const result = await call('problems_get', { code: 'p' }, () => json({ ...PROBLEM_DETAIL, samples: [] }));
    const data = result.data as { samples: { source: string; items: unknown[] } };
    expect(data.samples).toEqual({ source: 'statement-table', items: [{ input: '2 3', output: '5' }] });
  });

  it('falls back to the table against an API deployed before D94, which sends no samples key at all', async () => {
    const result = await call('problems_get', { code: 'tong-hai-so' }, () => json(PROBLEM_DETAIL));
    expect(new URL(result.last.url).pathname).toBe('/api/v1/problems/tong-hai-so');
    const data = result.data as { samples: { source: string; items: unknown[] }; statement: string };
    expect(data.samples).toEqual({
      source: 'statement-table',
      items: [{ input: '2 3', output: '5' }],
    });
    expect(data.statement).toContain('## Ví dụ');
    expect(result.summary).toContain('1 sample(s)');
  });

  it('says `none` — not "no samples" — when the statement has no table', async () => {
    const result = await call('problems_get', { code: 'x' }, () =>
      json({ ...PROBLEM_DETAIL, statement: 'just prose' }),
    );
    expect((result.data as { samples: { source: string } }).samples.source).toBe('none');
  });
});

describe('problems_stats and problems_editorial', () => {
  it('reads stats and keeps only the five fastest runs', async () => {
    const fastest = Array.from({ length: 9 }, (_unused, index) => ({
      submissionId: index,
      username: 'u',
      timeMs: index,
      memoryKb: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const result = await call('problems_stats', { code: 'p' }, () =>
      json({
        totalSubmissions: 9,
        attemptedUsers: 3,
        solvedUsers: 2,
        acceptanceRate: 0.5,
        verdicts: [],
        languages: [],
        fastest,
        firstSolver: null,
      }),
    );
    expect(new URL(result.last.url).pathname).toBe('/api/v1/problems/p/stats');
    expect((result.data as { fastest: unknown[] }).fastest).toHaveLength(5);
  });

  it('reads an editorial', async () => {
    const result = await call('problems_editorial', { code: 'p' }, () =>
      json({ markdown: '# how' }),
    );
    expect(new URL(result.last.url).pathname).toBe('/api/v1/problems/p/editorial');
    expect(result.data).toEqual({ code: 'p', markdown: '# how' });
  });
});

describe('submissions_list and submissions_get', () => {
  it('passes every filter through', async () => {
    const result = await call(
      'submissions_list',
      { problem: 'p', user: 'lam', verdict: 'AC', contest: 'k', limit: 5 },
      () => json({ items: [], nextCursor: null }),
    );
    const url = new URL(result.last.url);
    expect(url.pathname).toBe('/api/v1/submissions');
    expect(url.searchParams.get('problem')).toBe('p');
    expect(url.searchParams.get('user')).toBe('lam');
    expect(url.searchParams.get('verdict')).toBe('AC');
    expect(url.searchParams.get('contest')).toBe('k');
  });

  it('summarises the cases and withholds the source unless asked', async () => {
    const result = await call('submissions_get', { id: 7 }, () => json(SUBMISSION_DETAIL));
    expect(new URL(result.last.url).pathname).toBe('/api/v1/submissions/7');
    const data = result.data as Record<string, unknown>;
    expect(data['source']).toBeUndefined();
    expect(data['caseDetail']).toBeUndefined();
    expect(data['cases']).toEqual({
      total: 3,
      skipped: 1,
      byVerdict: { AC: 1, WA: 1, unjudged: 1 },
      firstFailure: {
        groupIndex: 1,
        caseIndex: 1,
        verdict: 'WA',
        timeMs: 2,
        memoryKb: 2,
        feedback: 'wrong answer on line 1',
      },
    });
    expect(result.summary).toBe('#7 tong-hai-so: WA 40/100');
  });

  it('includes the source and the full case list when asked', async () => {
    const result = await call('submissions_get', { id: 7, includeSource: true, includeCases: true }, () =>
      json(SUBMISSION_DETAIL),
    );
    const data = result.data as Record<string, unknown>;
    expect(data['source']).toBe('int main(){}');
    expect(data['caseDetail']).toHaveLength(3);
  });
});

describe('contest reads', () => {
  it('lists contests, narrowed to an org', async () => {
    const result = await call('contests_list', { org: 'thpt' }, () =>
      json({ items: [], nextCursor: null }),
    );
    const url = new URL(result.last.url);
    expect(url.pathname).toBe('/api/v1/contests');
    expect(url.searchParams.get('org')).toBe('thpt');
  });

  it('reads one contest with its problems', async () => {
    const result = await call('contests_get', { key: 'hsg' }, () =>
      json({
        id: 1,
        key: 'hsg',
        name: 'HSG',
        startTime: '2026-01-01T00:00:00.000Z',
        endTime: '2026-01-01T05:00:00.000Z',
        format: 'ioi',
        visibility: 'public',
        pointsPrecision: 2,
        frozenLastMinutes: 60,
        timeLimitSeconds: null,
        isRated: true,
        orgs: [{ slug: 'thpt', name: 'THPT' }],
        createdAt: '2026-01-01T00:00:00.000Z',
        formatConfig: null,
        canEdit: false,
        problems: [{ code: 'a', name: 'A', label: 'A', points: 100, partial: true, order: 0 }],
      }),
    );
    expect(new URL(result.last.url).pathname).toBe('/api/v1/contests/hsg');
    expect((result.data as { orgs: string[] }).orgs).toEqual(['thpt']);
    expect(result.summary).toContain('1 problems');
  });

  it('re-keys a scoreboard row from problem code to label, and honours `top`', async () => {
    const row = (rank: number) => ({
      rank,
      participant: `u${String(rank)}`,
      virtual: 0,
      is_disqualified: false,
      score: 100,
      cumtime: 0,
      tiebreaker: 0,
      frozen_score: 100,
      frozen_cumtime: 0,
      frozen_tiebreaker: 0,
      submission_count: 1,
      format_data: { 'tong-hai-so': { points: 100, time: 5 } },
    });
    const result = await call('contests_scoreboard', { key: 'hsg', top: 2 }, () =>
      json({
        label_by_problem: { 'tong-hai-so': 'A' },
        problems: [
          { code: 'tong-hai-so', label: 'A', points: 100, points_scaling_factor: null, total_ac: 3, first_solve: 'u1' },
        ],
        ranking: [row(1), row(2), row(3)],
        frozen: true,
        frozenAt: '2026-01-01T04:00:00.000Z',
      }),
    );
    const data = result.data as { ranking: { scores: Record<string, number> }[]; frozen: boolean };
    expect(data.ranking).toHaveLength(2);
    expect(data.ranking[0]!.scores).toEqual({ A: 100 });
    expect(result.summary).toContain('(frozen)');
  });

  it('reads clarifications', async () => {
    const result = await call('contests_clarifications', { key: 'hsg' }, () =>
      json({ items: [], truncated: true }),
    );
    expect(new URL(result.last.url).pathname).toBe('/api/v1/contests/hsg/clarifications');
    expect(result.summary).toContain('(truncated)');
  });
});

describe('me_progress', () => {
  it('reads the caller\'s own progress and totals the tag solves', async () => {
    const result = await call('me_progress', {}, () =>
      json({
        byTag: [
          { slug: 'dp', nameVi: 'QHĐ', nameEn: 'DP', solved: 2, attempted: 4 },
          { slug: 'graphs', nameVi: 'Đồ thị', nameEn: 'Graphs', solved: 1, attempted: 1 },
        ],
        byDifficulty: [],
        heatmap: { timezone: 'UTC', from: 'a', to: 'b', days: [] },
        streak: { current: 3, longest: 9, lastDate: null },
        recent: [],
        upcomingContests: [],
        homework: [],
      }),
    );
    expect(new URL(result.last.url).pathname).toBe('/api/v1/users/me/progress');
    expect(result.summary).toBe('3 tag-solves, streak 3 day(s) (longest 9)');
  });
});

describe('write tools', () => {
  it('submits, carrying the contest key only when there is one', async () => {
    const withContest = await call(
      'submissions_submit',
      { problemCode: 'p', languageKey: 'cpp17', source: 'x', contestKey: 'hsg' },
      () => json({ id: 42 }, { status: 201 }),
    );
    expect(withContest.last.method).toBe('POST');
    expect(await withContest.last.json()).toEqual({
      problemCode: 'p',
      languageKey: 'cpp17',
      source: 'x',
      contestKey: 'hsg',
    });
    expect(withContest.summary).toBe('submitted #42 to p as cpp17');

    const practice = await call(
      'submissions_submit',
      { problemCode: 'p', languageKey: 'cpp17', source: 'x' },
      () => json({ id: 43 }, { status: 201 }),
    );
    expect(await practice.last.json()).toEqual({
      problemCode: 'p',
      languageKey: 'cpp17',
      source: 'x',
    });
  });

  it('asks a clarification', async () => {
    const result = await call(
      'contests_ask',
      { key: 'hsg', question: 'Is n ≤ 10^5?', problemCode: 'a' },
      () =>
        json({
          id: 3,
          problemCode: 'a',
          askedBy: 'lam',
          question: 'Is n ≤ 10^5?',
          answer: null,
          answeredBy: null,
          answeredAt: null,
          visibility: 'private',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
    );
    expect(new URL(result.last.url).pathname).toBe('/api/v1/contests/hsg/clarifications');
    expect(await result.last.json()).toEqual({ question: 'Is n ≤ 10^5?', problemCode: 'a' });
  });

  it('announces', async () => {
    const result = await call('contests_announce', { key: 'hsg', text: 'Bài B đã sửa' }, () =>
      json({
        id: 4,
        problemCode: null,
        askedBy: 'lam',
        question: null,
        answer: 'Bài B đã sửa',
        answeredBy: 'lam',
        answeredAt: null,
        visibility: 'public',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect(new URL(result.last.url).pathname).toBe('/api/v1/contests/hsg/announcements');
    expect(await result.last.json()).toEqual({ text: 'Bài B đã sửa' });
  });

  it('patches only the fields it was given', async () => {
    const result = await call(
      'problems_patch',
      { code: 'p', difficulty: 4, tags: ['dp'] },
      () => json(PROBLEM_DETAIL),
    );
    expect(result.last.method).toBe('PATCH');
    expect(await result.last.json()).toEqual({ difficulty: 4, tags: ['dp'] });
  });

  it('refuses an empty patch without making a request', async () => {
    const stubbed = stub(() => json(PROBLEM_DETAIL));
    await expect(
      tool('problems_patch').run(stubbed.client, { code: 'p' }, fakeContext()),
    ).rejects.toBeInstanceOf(ApiFailure);
    expect(stubbed.calls).toHaveLength(0);
  });

  it('patches a null difficulty rather than dropping it', async () => {
    const result = await call('problems_patch', { code: 'p', difficulty: null }, () =>
      json(PROBLEM_DETAIL),
    );
    expect(await result.last.json()).toEqual({ difficulty: null });
  });

  it('opens a draft', async () => {
    const result = await call('problems_draft_create', { code: 'p' }, () =>
      json(
        {
          draftId: '11111111-2222-3333-4444-555555555555',
          expiresAt: '2026-01-02T00:00:00.000Z',
          maxFiles: 500,
          maxTotalBytes: 1,
        },
        { status: 201 },
      ),
    );
    expect(result.last.method).toBe('POST');
    expect(new URL(result.last.url).pathname).toBe('/api/v1/problems/p/drafts');
  });

  it('puts a draft file as raw bytes, not as JSON', async () => {
    const result = await call(
      'problems_draft_put_file',
      {
        code: 'p',
        draftId: '11111111-2222-3333-4444-555555555555',
        name: 'manifest.json',
        content: '{"a":1}',
      },
      () => json({ name: 'manifest.json', sizeBytes: 7, fileCount: 1, totalBytes: 7 }),
    );
    expect(result.last.method).toBe('PUT');
    expect(new URL(result.last.url).pathname).toBe(
      '/api/v1/problems/p/drafts/11111111-2222-3333-4444-555555555555/files/manifest.json',
    );
    expect(result.last.headers.get('content-type')).toBe('application/octet-stream');
    // The bytes of the file, NOT a JSON-encoded copy of the string.
    expect(await result.last.text()).toBe('{"a":1}');
  });

  it('builds a draft, defaulting `publish` to false', async () => {
    const result = await call(
      'problems_draft_build',
      { code: 'p', draftId: '11111111-2222-3333-4444-555555555555' },
      () => json({ version: 3, packageHash: 'a'.repeat(64), published: false }, { status: 201 }),
    );
    expect(await result.last.json()).toEqual({ publish: false });
    expect(result.summary).toContain('revision 3 (draft)');
  });
});

describe('error mapping', () => {
  it('carries the problem+json code and detail through', async () => {
    const stubbed = stub(() =>
      problem(404, { code: 'problem_not_found', detail: 'no such problem, or one you may not see' }),
    );
    const failure = await tool('problems_get')
      .run(stubbed.client, { code: 'nope' }, fakeContext())
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect((failure as ApiFailure).code).toBe('problem_not_found');
    expect((failure as ApiFailure).status).toBe(404);
    expect((failure as ApiFailure).toJSON()).toEqual({
      error: {
        code: 'problem_not_found',
        detail: 'no such problem, or one you may not see',
        status: 404,
      },
    });
  });

  it('turns D80\'s Retry-After into a retryAfterSeconds field', async () => {
    const stubbed = stub(() =>
      problem(
        429,
        { code: 'submission_rate_limited', detail: 'submitting too quickly' },
        { 'Retry-After': '7' },
      ),
    );
    const failure = (await tool('submissions_submit')
      .run(stubbed.client, { problemCode: 'p', languageKey: 'cpp17', source: 'x' }, fakeContext())
      .catch((err: unknown) => err)) as ApiFailure;
    expect(failure.retryAfterSeconds).toBe(7);
    expect(failure.toJSON().error.retryAfterSeconds).toBe(7);
    expect(failure.summary()).toContain('try again in 7s');
  });

  it('carries field errors from a 422', async () => {
    const stubbed = stub(() =>
      problem(422, { code: 'validation_failed', detail: 'bad', fields: { source: ['too long'] } }),
    );
    const failure = (await tool('submissions_submit')
      .run(stubbed.client, { problemCode: 'p', languageKey: 'cpp17', source: 'x' }, fakeContext())
      .catch((err: unknown) => err)) as ApiFailure;
    expect(failure.fields).toEqual({ source: ['too long'] });
  });
});

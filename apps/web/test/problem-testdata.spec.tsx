import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { ProblemTestDataTab } from '../src/routes/problem-testdata.js';

// Same mocking shape as problem-revisions.spec.tsx: this tab reaches the
// network only through `api`.
vi.mock('../src/api.js', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() },
}));

const mockedGet = vi.mocked(api.GET);
const mockedPost = vi.mocked(api.POST);
const mockedPut = vi.mocked(api.PUT);
const mockedDelete = vi.mocked(api.DELETE);

afterEach(() => {
  mockedGet.mockReset();
  mockedPost.mockReset();
  mockedPut.mockReset();
  mockedDelete.mockReset();
});

function ok(data: unknown) {
  return { data, error: undefined, response: new Response() };
}
function failed(body: { code: string; detail?: string }) {
  return { data: undefined, error: body, response: new Response(null, { status: 422 }) };
}

/** Adds one case and fills both boxes. */
async function addFilledCase(user: ReturnType<typeof userEvent.setup>, input: string, answer: string) {
  await user.click(screen.getByRole('button', { name: 'Thêm test' }));
  const inputs = screen.getAllByLabelText('Đầu vào');
  const answers = screen.getAllByLabelText('Đáp án');
  await user.type(inputs[inputs.length - 1]!, input);
  await user.type(answers[answers.length - 1]!, answer);
}

describe('the test-data tab', () => {
  it('opens a draft, PUTs the manifest and every file, then builds — in that order', async () => {
    const user = userEvent.setup();
    mockedPost
      .mockResolvedValueOnce(ok({ draftId: 'd1', expiresAt: 'x', maxFiles: 500, maxTotalBytes: 1 }) as never)
      .mockResolvedValueOnce(ok({ version: 3, packageHash: 'a'.repeat(64), published: true }) as never);
    mockedPut.mockResolvedValue(ok({ name: 'x', sizeBytes: 1, fileCount: 1, totalBytes: 1 }) as never);

    render(<ProblemTestDataTab code="abc" />);
    await addFilledCase(user, '1 2', '3');
    await user.click(screen.getByLabelText('Công bố phiên bản này ngay'));
    await user.click(screen.getByRole('button', { name: 'Tạo phiên bản' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Đã tạo và công bố phiên bản 3.');
    });

    // The draft is opened first, and the build asks for a publish.
    expect(mockedPost.mock.calls[0]![0]).toBe('/problems/{code}/drafts');
    expect(mockedPost.mock.calls[1]![0]).toBe('/problems/{code}/drafts/{draftId}/build');
    expect((mockedPost.mock.calls[1]![1] as { body: { publish: boolean } }).body.publish).toBe(true);

    // manifest.json first — a build against a half-filled draft then fails
    // naming a missing TEST rather than a missing manifest.
    const names = mockedPut.mock.calls.map((c) => (c[1] as { params: { path: { name: string } } }).params.path.name);
    expect(names).toEqual(['manifest.json', '01.in', '01.out']);
  });

  it("shows the server's own build refusal verbatim, and discards the draft", async () => {
    const user = userEvent.setup();
    mockedPost
      .mockResolvedValueOnce(ok({ draftId: 'd1', expiresAt: 'x', maxFiles: 500, maxTotalBytes: 1 }) as never)
      .mockResolvedValueOnce(
        failed({
          code: 'draft_build_failed',
          detail: 'manifest references files that are not in the package: 02.out',
        }) as never,
      );
    mockedPut.mockResolvedValue(ok({ name: 'x', sizeBytes: 1, fileCount: 1, totalBytes: 1 }) as never);
    mockedDelete.mockResolvedValue(ok(undefined) as never);

    render(<ProblemTestDataTab code="abc" />);
    await addFilledCase(user, '1 2', '3');
    await user.click(screen.getByRole('button', { name: 'Tạo phiên bản' }));

    // Verbatim: the sentence names the file, which is the whole value of it.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'manifest references files that are not in the package: 02.out',
      );
    });
    expect(mockedDelete).toHaveBeenCalledWith('/problems/{code}/drafts/{draftId}', {
      params: { path: { code: 'abc', draftId: 'd1' } },
    });
  });

  it('a sample is worth nothing, and says so in the total', async () => {
    const user = userEvent.setup();
    render(<ProblemTestDataTab code="abc" />);

    await addFilledCase(user, '1 2', '3');
    const points = screen.getByLabelText('Điểm của test 1');
    await user.clear(points);
    await user.type(points, '40');
    expect(screen.getByText('1 test, tổng 40 điểm')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Test 1 là ví dụ'));
    // Disabled, not merely ignored: a number typed into a box whose value is
    // then silently dropped is worse than not offering the box.
    expect(points).toBeDisabled();
    expect(screen.getByText('1 test, tổng 0 điểm')).toBeInTheDocument();
  });

  it('refuses to create a revision with no test cases at all', () => {
    render(<ProblemTestDataTab code="abc" />);
    expect(screen.getByRole('button', { name: 'Tạo phiên bản' })).toBeDisabled();
    expect(screen.getByText('Chưa có test nào.')).toBeInTheDocument();
  });

  it('pairs a bulk selection by stem and names what it could not pair', async () => {
    const user = userEvent.setup();
    render(<ProblemTestDataTab code="abc" />);

    await user.upload(screen.getByLabelText('Thêm nhiều tệp (.in cùng .out hoặc .a)'), [
      new File(['1 2\n'], '01.in'),
      new File(['3\n'], '01.out'),
      new File(['4 5\n'], '02.in'),
    ]);

    await waitFor(() => {
      expect(screen.getByText('1 test, tổng 0 điểm')).toBeInTheDocument();
    });
    expect(screen.getByTestId('unpaired')).toHaveTextContent('02.in thiếu tệp đáp án — chưa thêm.');
    expect(screen.getAllByLabelText('Đầu vào')[0]).toHaveValue('1 2\n');
  });

  it('loads the published revision back into the table, then discards the draft it read through', async () => {
    const user = userEvent.setup();
    mockedGet
      // The revisions list, to find which version is published.
      .mockResolvedValueOnce(
        ok([
          { version: 1, state: 'archived' },
          { version: 2, state: 'published' },
          { version: 3, state: 'draft' },
        ]) as never,
      )
      .mockResolvedValueOnce(ok('1 2\n') as never)
      .mockResolvedValueOnce(ok('3\n') as never)
      .mockResolvedValueOnce(ok('// checker\n') as never);
    mockedPost.mockResolvedValueOnce(
      ok({
        draftId: 'd7',
        expiresAt: 'x',
        maxFiles: 500,
        maxTotalBytes: 1,
        fromVersion: 2,
        fileCount: 4,
        totalBytes: 12,
        prefill: {
          name: 'abc',
          timeMs: 2500,
          memoryKb: 131072,
          checker: { kind: 'source', path: 'checker.cpp', language: 'cpp17' },
          cases: [{ input: '01.in', answer: '01.out', points: 40, group: 2, sample: false }],
        },
      }) as never,
    );
    mockedDelete.mockResolvedValue(ok(undefined) as never);

    render(<ProblemTestDataTab code="abc" />);
    await user.click(screen.getByRole('button', { name: 'Tải từ phiên bản đã công bố' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Đã tải dữ liệu chấm từ phiên bản 2.');
    });
    // The PUBLISHED version, not the newest draft one.
    expect(mockedPost.mock.calls[0]![0]).toBe('/problems/{code}/drafts/from-revision/{version}');
    expect((mockedPost.mock.calls[0]![1] as { params: { path: { version: number } } }).params.path.version).toBe(2);

    // Limits, checker and the case itself all came back.
    expect(screen.getByLabelText('Giới hạn thời gian (ms)')).toHaveValue(2500);
    expect(screen.getByLabelText('Trình chấm')).toHaveValue('source');
    expect(screen.getAllByLabelText('Đầu vào')[0]).toHaveValue('1 2\n');
    expect(screen.getAllByLabelText('Đáp án')[0]).toHaveValue('3\n');
    expect(screen.getByLabelText('Điểm của test 1')).toHaveValue(40);
    expect(screen.getByLabelText('Nhóm của test 1')).toHaveValue(2);
    expect(screen.getByText('1 test, tổng 40 điểm')).toBeInTheDocument();

    // The draft was only ever a way to READ: it is handed back, because the
    // build path opens its own.
    expect(mockedDelete).toHaveBeenCalledWith('/problems/{code}/drafts/{draftId}', {
      params: { path: { code: 'abc', draftId: 'd7' } },
    });
  });

  it('says so when the problem has no revision to load', async () => {
    const user = userEvent.setup();
    mockedGet.mockResolvedValueOnce(ok([]) as never);

    render(<ProblemTestDataTab code="abc" />);
    await user.click(screen.getByRole('button', { name: 'Tải từ phiên bản đã công bố' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Bài này chưa có phiên bản nào để tải.');
    });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('offers the checker source editor only when a source checker is chosen (D40)', async () => {
    const user = userEvent.setup();
    render(<ProblemTestDataTab code="abc" />);
    expect(screen.queryByText(/checker\.cpp/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Trình chấm'), 'source');
    expect(
      screen.getByText('Đóng gói thành checker.cpp và chạy như trình chấm testlib qua bridged.'),
    ).toBeInTheDocument();
  });

  it('gives each per-case file input an accessible name (WCAG 4.1.2)', async () => {
    const user = userEvent.setup();
    render(<ProblemTestDataTab code="abc" />);
    await user.click(screen.getByRole('button', { name: 'Thêm test' }));
    // The row's <label for> points at the textarea, so before this fix the
    // two file inputs beside it had no accessible name at all — a screen
    // reader announced a bare "choose file" with no clue which case, or
    // whether it fed the input or the answer.
    expect(screen.getByLabelText('Tải tệp đầu vào cho test 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Tải tệp đáp án cho test 1')).toBeInTheDocument();
  });
});

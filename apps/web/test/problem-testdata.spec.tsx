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

const mockedPost = vi.mocked(api.POST);
const mockedPut = vi.mocked(api.PUT);
const mockedDelete = vi.mocked(api.DELETE);

afterEach(() => {
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

  it('offers the checker source editor only when a source checker is chosen (D40)', async () => {
    const user = userEvent.setup();
    render(<ProblemTestDataTab code="abc" />);
    expect(screen.queryByText(/checker\.cpp/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Trình chấm'), 'source');
    expect(
      screen.getByText('Đóng gói thành checker.cpp và chạy như trình chấm testlib qua bridged.'),
    ).toBeInTheDocument();
  });
});

# Chuẩn bị đề: từ thư mục đã soạn tới bài tập chạy thật

Dành cho người ra đề đã có sẵn một thư mục đề — do bộ kỹ năng
`competitive-programming` sinh ra, hoặc theo bố cục Polygon như
`content/problems/*` — và muốn kiểm tra rồi đưa lên DuckOJ bằng **một lệnh**.

    corepack pnpm prepare:problem <thư-mục-đề>

Lệnh này chạy **cổng kiểm tra** (gate): nó không sửa gì trong thư mục của bạn,
chỉ trả lời một câu — *đề này đã sẵn sàng chưa* — rồi ghi `prepare-report.json`
bên cạnh thư mục và thoát khác 0 nếu có gì hỏng.

## 1. Hai bố cục được nhận

`prepare` tự nhận ra bố cục, không cần khai báo.

| Bố cục | Dấu hiệu | Thư mục có gì |
| --- | --- | --- |
| **Polygon** | `problem.xml` | `statement.md`, `solution.cpp`, `tests/01`, `tests/01.a`, … |
| **Bộ kỹ năng** | `problem.json` | `files/validator.cpp`, `files/gen-*.cpp`, `solutions/*.cpp`, `tests/<nhóm>/01.in` + `01.a`, `flags.json` |

Nếu có cả hai, `problem.xml` thắng: đó là tệp `@duckoj/polygon-import` đọc, và
gói dựng ra từ nó **trùng mã băm** với gói `polygon:import` + `package:build`
dựng — đúng bản đề mà mọi bài nộp được chấm dựa vào.

**Đề bài phải là Markdown.** Bộ kỹ năng sinh ra `statement.tex` (vnolymp) —
đó là bản in, DuckOJ không lưu được. Hãy thêm một trong hai:

- `statement.md`: tiếng Việt trước, rồi một mục `## English` (D10); hoặc
- `statement.vi.md` + `statement.en.md`: `prepare` tự ghép thành một tài liệu.

## 2. Cổng kiểm tra làm những gì

Mỗi dòng trong báo cáo là một câu hỏi, trả lời `[x]` đạt, `[!]` hỏng, `[ ]`
không áp dụng. **`[ ]` không phải là "đạt"**: nó nói rõ việc đó *không chạy*,
để "chưa từng chạy lời giải mẫu" không bao giờ bị đọc nhầm thành "lời giải
mẫu khớp".

| Mục | Hỏng khi |
| --- | --- |
| `statement` | thiếu đề Markdown, hoặc thiếu mục tiếng Anh (D10) |
| `manifest` | `problem.xml` / `problem.json` không đọc được, hoặc manifest không hợp lệ |
| `tests` | có test thiếu tệp đáp án, hoặc đáp án **rỗng** (dấu vết của một lần sinh test bị sập) |
| `limits` | giới hạn thời gian ngoài 100–60000 ms, bộ nhớ ngoài 16 MiB–1 GiB |
| `flags` | còn cờ **`statement-ambiguity` mức `high`** chưa gỡ trong `flags.json` |
| `checker` | trình chấm nguồn không biên dịch được |
| `validator` | validator từ chối một test mà gói đang mang |
| `model` | lời giải mẫu không biên dịch, hoặc không tái tạo đúng một `.a` nào đó |
| `matrix` | một lời giải khai `@expect <nhóm>=<verdict>` nhưng chạy ra kết quả khác |

Vài điều đáng biết:

- **Quá thời gian tính theo đồng hồ tường, ngưỡng là 2× giới hạn.** Đây là
  cổng chạy trên máy bạn bằng `timeout` và `ulimit -v`, **không phải** hộp cát
  chấm bài — code ở đây là code của chính bạn.
- **`ML` và `RE` không phân biệt được** dưới `ulimit -v`: một chương trình
  C++ chạm trần bộ nhớ chết y hệt mọi kiểu sập khác. Vì vậy `@expect g1=ML`
  được chấp nhận khi quan sát ra `RE`.
- **Cờ chặn duy nhất** là cờ mà chính `reviewing-problems` gọi là điểm dừng
  cứng: `statement-ambiguity` mức `high` chưa giải quyết. Mọi cờ khác chỉ
  được ghi lại. Đã xử lý xong thì thêm `"resolved": true` vào bản ghi đó
  trong `flags.json` (D90).
- **Không có testlib thì `prepare` từ chối**, kèm câu chỉ cách khắc phục: đặt
  `TESTLIB_DIR`, để `files/testlib.h` cạnh đề, hoặc chạy
  `tools/bootstrap_testlib.sh` của plugin để có `~/.cache/testlib`.

Muốn nhanh, chỉ kiểm tra cấu trúc mà không biên dịch gì: thêm `--quick`.

## 3. Dò lỗi lời giải mẫu bằng stress test

    corepack pnpm prepare:problem stress <thư-mục-đề> \
      --brute brute.cpp --gen stress-gen.py --rounds 200

**Giao ước của bộ sinh: `<gen> <seed>` in ra ĐÚNG MỘT test lên stdout.** Đây
không phải hình dạng của các `gen.py` trong `content/problems/` — những tệp đó
sinh lại cả thư mục `tests/`, là việc khác. Hãy viết riêng một bộ sinh cho
vòng lặp này.

Hai chương trình được so bằng **trình chấm của chính đề** chứ không so chuỗi,
nên bài nhiều đáp án đúng không bị báo sai. Phản ví dụ đầu tiên được in ra
kèm đầu vào, kết quả của lời giải mẫu và kết quả của brute. Brute mà chết thì
lệnh **từ chối** thay vì coi đó là phản ví dụ — người làm trọng tài phải đúng.

## 4. Đóng gói và đưa lên

    corepack pnpm prepare:problem publish <thư-mục-đề> \
      --base-url http://localhost:8080/api/v1 \
      --token "$DUCKOJ_TOKEN" \
      --publish --visibility public

Trình tự: chạy cổng kiểm tra → dựng gói → tạo hoặc cập nhật bài → tải gói lên
→ gắn bản (revision) → công bố. Hỏng ở cổng kiểm tra là dừng, không có gì
chạm tới máy chủ.

- **Token** cần ba phạm vi: `problems:write`, `problems:publish`,
  `packages:write`. Mint ở `/settings` hoặc `POST /auth/tokens` (chỉ phiên
  đăng nhập thật mới mint được token). Có thể đặt qua biến môi trường
  `DUCKOJ_TOKEN` và `DUCKOJ_API`.
- **Chạy lại là an toàn.** Nội dung không đổi thì mã băm không đổi, và
  `prepare` **không** gắn bản mới — nó nhận ra bản cũ đã mang đúng gói ấy.
  Đề bài, nhãn và độ khó vẫn được cập nhật mỗi lần.
- **Nhãn và độ khó** lấy từ `meta.json` cạnh đề, `tags.json` cạnh đề, rồi
  `tags.json` ở thư mục cha (đúng chỗ `content/tags.json` nằm). Tra theo mã
  bài **và** theo tên thư mục, nên xuất bản thử dưới mã `prep-...` vẫn giữ
  nguyên phân loại.
- **`editorial.md`**, nếu có, được đăng luôn trong cùng lần chạy (D43 quyết
  định ai đọc được nó, nên đăng ngay không làm lộ đề của kỳ thi đang chạy).
- **`--code`** đổi mã bài trên DuckOJ; mặc định là tên thư mục.

`prepare package <thư-mục> --out <thư-mục-gói> --archive bai.tar.zst` dựng gói
mà không cần máy chủ nào đang chạy, và in ra mã băm.

## 5. Cả quy trình, từ ý tưởng tới bài chạy thật

1. Bộ kỹ năng `competitive-programming` dựng thư mục đề: `problem.json`,
   test, `solutions/*.cpp` có `@tag`/`@expect`, `flags.json`.
2. Thêm `statement.md` (Việt + Anh) — bản `.tex` giữ nguyên, DuckOJ không đọc.
3. `corepack pnpm prepare:problem <dir>` cho tới khi **READY**.
4. `corepack pnpm prepare:problem stress ...` nếu còn nghi lời giải mẫu.
5. `corepack pnpm prepare:problem publish <dir> --publish` — xong.

---

## English

### Preparing a problem: from a prepared directory to a live problem

For a setter who already has a problem directory — produced by the
`competitive-programming` skills, or in the Polygon layout that
`content/problems/*` uses — and wants it checked and published in **one
command**.

    corepack pnpm prepare:problem <problem-dir>

That runs the **gate**. It changes nothing in your directory; it answers one
question — *is this problem ready* — writes `prepare-report.json` beside it,
and exits non-zero if anything is wrong.

### 1. The two layouts

Detection is automatic: `problem.xml` means Polygon, `problem.json` means the
skills' layout, and a directory carrying both is read as Polygon — that is the
file `@duckoj/polygon-import` reads, and the package built from it has the
**same hash** as `polygon:import` + `package:build` produce, which is the
package every submission is graded against.

**The statement must be Markdown.** The skills produce `statement.tex`
(vnolymp), which is a typesetting source DuckOJ cannot store. Add either
`statement.md` (Vietnamese, then an `## English` section, per D10) or
`statement.vi.md` + `statement.en.md`, which `prepare` joins for you.

### 2. What the gate checks

`[x]` passed, `[!]` failed, `[ ]` did not apply. **`[ ]` is never a soft
pass** — it names what was not run, so "the model solution was never checked"
cannot be misread as "the model solution agreed".

The checks are `statement` (Vietnamese and English), `manifest`, `tests`
(every test has a non-empty answer), `limits`, `flags`, `checker` (compiles),
`validator` (accepts every test the package ships), `model` (compiles and
reproduces every `.a` through the problem's own checker, under the time and
memory limits) and `matrix` (every `@expect group=VERDICT` a solution declares
is the verdict it actually gets).

- **TLE is wall-clock at 2× the limit.** This is a local gate built on
  `timeout` and `ulimit -v`, not the grading sandbox — the code it runs is
  your own.
- **`ML` and `RE` are indistinguishable** under an address-space limit, so a
  declared `ML` is satisfied by an observed `RE`.
- **The only blocking flag** is the one `reviewing-problems` itself calls a
  hard stop: an unresolved HIGH `statement-ambiguity`. Everything else in
  `flags.json` is reported and continues. Mark a resolved one with
  `"resolved": true` (D90).
- **No testlib, no checker.** `prepare` refuses with the fix in the message:
  `TESTLIB_DIR`, a vendored `files/testlib.h`, or the plugin's
  `tools/bootstrap_testlib.sh`.

`--quick` runs the structural checks only and compiles nothing.

### 3. Stress testing the model solution

    corepack pnpm prepare:problem stress <problem-dir> \
      --brute brute.cpp --gen stress-gen.py --rounds 200

**The generator contract is `<gen> <seed>` writing ONE case to stdout.** The
`gen.py` files under `content/problems/` do not have that shape — they
regenerate a whole `tests/` directory, which is a different job — so write a
generator for this loop. The two programs are compared through the problem's
own checker, not by string equality, so a problem with several correct answers
is not reported as broken. A brute force that crashes is a refusal, not a
counterexample: the oracle has to be right.

### 4. Packaging and publishing

    corepack pnpm prepare:problem publish <problem-dir> \
      --base-url http://localhost:8080/api/v1 --token "$DUCKOJ_TOKEN" \
      --publish --visibility public

Gate, build, create-or-patch the problem, upload the package, attach a
revision, publish. A failing gate stops before anything reaches the server.

The token needs `problems:write`, `problems:publish` and `packages:write`
(`DUCKOJ_TOKEN` and `DUCKOJ_API` work as environment variables). **Re-running
is safe**: unchanged content hashes the same and attaches no new revision,
while the statement, tags and difficulty are patched every time. Tags and
difficulty come from `meta.json` or `tags.json` beside the problem, then a
`tags.json` in an ancestor — looked up under both the problem code and the
directory name, so a `prep-...` rehearsal keeps its classification.
`editorial.md`, if present, is published in the same run (D43 decides who may
read it). `--code` overrides the code, which defaults to the directory name.

`prepare package <dir> --out <package-dir> --archive problem.tar.zst` builds
the package with no server running and prints its hash.

### 5. The whole path

1. The skills build the directory: `problem.json`, tests, `solutions/*.cpp`
   with `@tag`/`@expect`, `flags.json`.
2. Add `statement.md` in both languages.
3. `corepack pnpm prepare:problem <dir>` until it says **READY**.
4. `corepack pnpm prepare:problem stress ...` if the model solution is still in doubt.
5. `corepack pnpm prepare:problem publish <dir> --publish`.

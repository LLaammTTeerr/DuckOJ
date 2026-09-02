# Trước khi triển khai thật

Danh sách kiểm tra cho đơn vị vận hành, chạy **một lần** trước khi tỉnh đưa
DuckOJ vào dùng thật. Máy chủ này cho tới nay là **nơi diễn tập**: nó mang
theo hàng trăm tài khoản, kỳ thi và đề bài do các vòng kiểm thử tự động sinh
ra, cùng với những bí mật đã bị nhìn thấy trong quá trình dựng. Không có bước
nào dưới đây là tuỳ chọn, và mỗi bước có một **điều kiện hoàn thành** kiểm
chứng được.

Tài liệu này **không lặp lại** `docs/runbook.md`: mỗi mục chỉ nêu việc phải
làm, lý do, và trỏ tới đúng mục trong runbook có sẵn dòng lệnh. Danh sách
những thứ tỉnh phải tự lo (SMTP, tên miền, bản sao lưu ngoài máy chủ, máy chấm
thứ hai) nằm ở `docs/PROVINCE-READINESS.md`; các quyết định thiết kế ở
`docs/DECISIONS.md`.

---

## 1. Xoay lại mọi bí mật đã gieo sẵn

Mọi giá trị trong `.env` và `.secrets/` trên máy diễn tập đều phải coi như **đã
lộ**. Chúng đã đi qua nhật ký, ảnh chụp màn hình và báo cáo.

| Giá trị              | Ở đâu                                                          | Xoay thế nào                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | `.env`, và trong `DATABASE_URL` của `api`, `judged`, `migrate` | Đổi mật khẩu trong Postgres (`ALTER ROLE duckoj PASSWORD …`), sửa `.env`, rồi `scripts/compose-up.sh`                                                           |
| `TOTP_ENC_KEY`       | `.env`                                                         | **Không xoay được sau khi đã có người bật 2FA** — khoá này giải mã bí mật TOTP đang lưu. Sinh khoá mới **trước** khi có người dùng thật: `openssl rand -hex 32` |
| `JUDGE_TOKEN`        | `.env`, và bản băm trong bảng `judge_nodes`                    | `corepack pnpm judge:node rotate judge-1` — in token mới **một lần duy nhất**, giữ nguyên hàng và lịch sử chấm. Dán vào `.env` rồi **tạo lại** container `judge` (`podman-compose up -d judge`; `restart` **không** đọc lại `.env`). Máy chấm mất kết nối khoảng 5 giây sau khi xoay và bài đang chấm được **xếp lại hàng đợi**, không hỏng. Trình tự đầy đủ: `docs/runbook.md`, mục *Rotating a judge's token* (D204) |
| Mật khẩu `duckadmin` | `.secrets/duckadmin.txt`                                       | Xoá tài khoản diễn tập ở bước 4, hoặc đổi mật khẩu rồi **xoá tệp**                                                                                              |

`TOTP_ENC_KEY` là bước duy nhất **không quay lui được**: hãy làm nó trước
tiên, khi cơ sở dữ liệu chưa có xác thực hai lớp nào của người thật.

**Xong khi:** `.secrets/` rỗng, không giá trị nào trong `.env` trùng với giá
trị cũ, và cả stack vẫn `healthy` sau `scripts/compose-up.sh`.

## 2. Trỏ thư điện tử vào máy chủ thư thật

Không có `SMTP_HOST`, hệ thống **ghi thư ra nhật ký thay vì gửi** (D1) —
nhưng nó **không im lặng** về việc đó (D155, F-40): API cảnh báo lúc khởi
động, `GET /readyz` trả `"mail": "log"`, bảng **Thư điện tử** trên trang
`/admin` ghi *chưa cấu hình*, và trên `NODE_ENV=production` một yêu cầu đặt
lại mật khẩu bị **từ chối 503 `mail_unavailable`** thay vì báo với giáo viên
rằng thư đã được gửi. Người quên mật khẩu vẫn không nhận được gì — chỉ là hệ
thống nói ra điều đó.

Từ F-40, `docker-compose.yml` **đã truyền cả sáu biến** `SMTP_HOST`,
`SMTP_PORT` (mặc định 587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` và
`MAIL_FROM` vào dịch vụ `api`, mỗi biến mặc định **rỗng**. Không phải sửa
`docker-compose.yml` nữa: chỉ điền giá trị vào `.env`, và đặt `MAIL_FROM`
bằng một địa chỉ tên miền của tỉnh (mặc định `no-reply@duckoj.local` sẽ bị
chặn).

**Xong khi:** bảng **Thư điện tử** trên `/admin` ghi *SMTP* chứ không phải
*chưa cấu hình*, nút **Gửi thư kiểm tra** ở ngay dưới đó gửi được, và một tài
khoản thử đặt lại mật khẩu thấy thư về tới hộp thư thật, **không** nằm trong
thư mục rác.

## 3. Đặt tên miền, các nguồn, và hai công tắc chính sách

- `SITE_ADDRESS` — tên miền Caddy dùng để xin chứng chỉ TLS.
- `PUBLIC_ORIGIN` — nguồn hệ thống tự nhận, dùng trong liên kết thư và kiểm
  tra CSRF (D82).
- `WS_EXTRA_ORIGINS` — **phải rỗng**. Trên máy diễn tập nó chứa
  `localhost` để Playwright mở `/ws` được (D70); để nguyên là mở một lỗ hổng
  nguồn cho trình duyệt bất kỳ trên máy chủ.

**Hai công tắc quyết định tỉnh công bố gì và ai được vào.** Cả hai được
`docker-compose.yml` truyền vào `api` **không điều kiện** và mặc định **rỗng**;
rỗng nghĩa là nấc bảo vệ, và nấc đó nằm trong mã nguồn chứ không nằm trong
`.env`. **Không đặt gì cũng là một quyết định** — hãy quyết định có ý thức.

- `NAME_DISCLOSURE` (D197) — ai được xem **tên hiển thị thật**. Trên máy chủ
  của một tỉnh, tên hiển thị rất thường là họ tên đầy đủ của một đứa trẻ mười
  hai tuổi, vì danh sách lấy từ bảng tính của trường (D61).
  - `affiliated` — **mặc định**, nấc bảo vệ. Tên thật chỉ đến người có tư
    cách: quản trị viên, người ra đề, người đang giữ một vai trò trong một tổ
    chức bất kỳ, và chính chủ tài khoản. Người lạ và tài khoản vừa lập thấy
    **tên đăng nhập** ở chỗ tên hiển thị. Không có gì bị xoá trắng.
  - `authenticated` — tên thật cho **mọi người đã đăng nhập**. Giá phải trả:
    ai lập được tài khoản là lấy được cả danh sách tên.
  - `public` — tên thật cho **cả người lạ chưa đăng nhập**. Đây là hành vi
    trước D197 và chỉ đúng cho một judge công cộng của người lớn.
- `REGISTRATION` (D200) — ai được **tạo tài khoản**.
  - `closed` — **mặc định**. `POST /auth/register` trả 403 với mọi người trừ
    quản trị viên toàn hệ thống; trang `/register` nói thẳng lý do thay vì để
    người ta điền năm ô rồi gặp 403. Giá phải trả, nói thẳng: trường muốn học
    sinh tự ghi danh thì phải **nhập danh sách** thay vào đó (`corepack pnpm
    org:import`, D61) — chưa có nấc "mã mời".
  - `open` — ai cũng đăng ký được, có đo tần suất (D26). Đây là hành vi trước
    D200 và là nấc bạn **chủ động chọn**.

Đổi `NAME_DISCLOSURE` chỉ đổi thứ **được công bố**: không tên nào bị sửa,
không có migration, đặt lại là hành vi cũ trở về ngay.

**Xong khi:** mở trang bằng tên miền thật thấy khoá TLS, gửi được một bài và
thấy kết quả chạy về **không cần tải lại trang** (đường `/ws` sống),
`grep WS_EXTRA_ORIGINS .env` cho một dòng rỗng, và bảng **Vận hành** trên
`/admin` — mục *Cấu hình đang chạy* — hiện đúng hai nấc bạn định đặt. Bảng đó
đọc giá trị **tiến trình đang chạy** thật sự nhận được, nên nó là bằng chứng
duy nhất rằng giá trị trong `.env` đã tới nơi (bài học của F-40).

## 4. Dọn dữ liệu diễn tập

```
corepack pnpm tsx scripts/cleanup-test-data.ts            # xem trước, không đổi gì
CONFIRM=yes corepack pnpm tsx scripts/cleanup-test-data.ts --apply
```

Mặc định là **chạy thử**: giao dịch mở ở chế độ chỉ đọc rồi `ROLLBACK`, nên
không thể ghi kể cả khi muốn. Bản in liệt kê đầy đủ: tài khoản, kỳ thi, đội,
đơn vị, đề bài, bộ đề, bài nộp và thông báo sẽ bị xoá, theo đúng thứ tự khoá
ngoại; những dòng **bị từ chối** vì một hàng thật đang phụ thuộc vào chúng; và
những gì các hàng **được giữ** sẽ mất đi. Đọc hết ba phần đó trước khi gõ
`CONFIRM=yes` (xem D153).

Script chỉ nhận ra dữ liệu thử **theo tên**, dựa trên một danh sách tiền tố cố
định. Bộ dữ liệu trình diễn — `duckadmin`, `hocsinh1`, năm đề tiếng Việt và kỳ
`thu-nghiem-1` — nằm trong danh sách **cấm động tới**. Nếu tỉnh muốn giữ lại
bộ trình diễn để tập huấn giáo viên thì không cần làm gì thêm; nếu muốn xoá
luôn, hãy xoá bằng tay trên trang Quản trị, **sau** khi đã có quản trị viên
thật ở bước 6.

**Xong khi:** chạy thử lần thứ hai in `0 rows`, và
`corepack pnpm tsx scripts/integrity-check.ts --live` báo sạch.

## 5. Chứng minh bản sao lưu **khôi phục được**

Một bản sao lưu chưa từng được nạp lại không phải là bản sao lưu. Chuyện này
đã xảy ra thật: bản dump đêm mới nhất **không** nạp được lên một stack đang
chạy, vì lược đồ hôm nay có bảng mà bản dump chưa từng biết (D130).

Làm đúng bài diễn tập đã ghi trong D130 và `docs/runbook.md` mục _Restoring_:
dựng một compose project dùng một lần từ ảnh hiện tại, nạp bản dump đêm mới
nhất vào đó bằng `CONFIRM=yes scripts/restore.sh <prefix>`, rồi đếm số hàng.
Không diễn tập trên chính máy chủ sản xuất.

Đồng thời cài `deploy/duckoj-backup.timer` (runbook, _Boot and reboot_) và
**chép bản sao lưu ra khỏi máy chủ này** — bộ hẹn giờ chỉ giữ 14 bản trên
chính ổ đĩa sẽ hỏng cùng nó (D17).

**Xong khi:** `pg_restore` báo **0 lỗi** trên project dùng một lần, số hàng
khớp bản dump, và có ít nhất một bản sao nằm ở máy khác.

## 6. Tạo quản trị viên thật đầu tiên

`corepack pnpm bootstrap:admin <tên> --email <thư>` — xem
`docs/guide/quan-tri.md` mục _1. Quản trị viên đầu tiên_ và runbook mục
_Bootstrapping the first admin_ (có sẵn dòng `podman run` khi Postgres không
mở cổng ra ngoài).

Chỉ làm **một lần**. Từ đó mọi việc cấp quyền diễn ra trong web.

**Xong khi:** đăng nhập được bằng tài khoản đó, trang `/admin` mở ra, và mật
khẩu in một lần đã được cất vào nơi quản lý bí mật của tỉnh chứ không phải một
tệp trong thư mục mã nguồn.

## 7. Nhập đề thật

Ba đường, tuỳ nguồn đề — `content/README.md` cho thư mục đề sẵn có,
`corepack pnpm polygon:import` cho gói Polygon, `corepack pnpm prepare:problem`
cho một đề chuẩn bị trong một lệnh (D90, D97). Chi tiết ở
`docs/guide/chuan-bi-de.md`.

Nhập danh sách học sinh bằng `corepack pnpm org:import` (D61) — runbook mục
_Bulk student accounts for a school_. Tài khoản tạo theo đường này **buộc đổi
mật khẩu lần đăng nhập đầu** (D102).

**Xong khi:** mỗi đề thật nộp thử một lời giải mẫu và nhận `AC` từ máy chấm
thật, không phải từ bộ nhớ đệm.

## 8. Kiểm tra khi đã lên sóng

Chạy theo đúng thứ tự này, bằng **tên miền thật**, trên **một chiếc điện
thoại**, không phải trên máy chủ:

1. Mở trang chủ — có kỳ thi đang diễn ra thì nó hiện ở đầu (D151).
2. Đăng ký một tài khoản mới → nhận thư xác nhận thật (bước 2). Nếu bạn để
   `REGISTRATION` trống (mặc định, D200) thì bước này **phải** trả về 403 và
   trang `/register` phải nói ra lý do — đó là kết quả đúng. Khi ấy hãy tạo
   tài khoản thử bằng `corepack pnpm org:import` hoặc bằng tài khoản quản
   trị, rồi tiếp tục bước 3 với tài khoản đó.
3. Nộp một bài → kết quả tự về, không cần tải lại (bước 3); nếu đường trực
   tiếp bị chặn, trang tự chuyển sang hỏi lại mỗi bốn giây và **nói ra điều
   đó** (D152).
4. Mở một kỳ thi, vào thi, xem bảng xếp hạng.
5. `corepack pnpm tsx scripts/integrity-check.ts --live` → sạch.
6. Mở `/admin` → bảng **Vận hành**: hàng đợi chấm rỗng, máy chấm kết nối.
7. Khởi động lại máy chủ. Stack tự lên (runbook, _Boot and reboot_).

**Xong khi:** cả bảy mục đều đạt trong **một lần chạy**, sau khi đã khởi động
lại máy.

---

## English

The pre-production checklist a province runs **once**, before this instance
carries real pupils. Everything here has a checkable done-condition, and none
of it is optional — this host has been the rehearsal ground, so it carries
hundreds of generated accounts, contests and problems, and every secret on it
has been seen.

This page does **not** repeat `docs/runbook.md`. Each item says what and why,
and points at the runbook section that already has the command line. What the
province must supply is listed in `docs/PROVINCE-READINESS.md`; the design
rulings are in `docs/DECISIONS.md`.

### 1. Rotate every seeded secret

Treat every value in `.env` and `.secrets/` as leaked; they have all passed
through logs, screenshots and reports.

- **`POSTGRES_PASSWORD`** — `ALTER ROLE duckoj PASSWORD …`, edit `.env` (it
  feeds `DATABASE_URL` for `api`, `judged` and `migrate`), then
  `scripts/compose-up.sh`.
- **`TOTP_ENC_KEY`** — `openssl rand -hex 32`. This one **cannot be rotated
  once anybody has enrolled in two-factor**: the key decrypts the stored TOTP
  secrets. Do it first, while no real enrolment exists.
- **`JUDGE_TOKEN`** — `corepack pnpm judge:node rotate judge-1` (D204). It
  mints a new token for the node that exists, prints it **once**, and keeps
  the row, so the old name's grading history stays addressable. Do **not**
  reach for `revoke` then `add`: `add` refuses a name it already holds,
  revoked or not, so that sequence burns the credential and then fails — it
  is what this page told you to do until F-58, and it never worked. (If you
  already ran it, `rotate` works on the revoked node and says so; that is the
  way out.)

  Then paste the token into `.env` and **recreate** the judge container —
  `podman-compose up -d judge`, not `podman restart`, which re-uses the
  environment the container was created with. Between the rotation and the
  recreate the judge is disconnected (about five seconds after the command)
  and submissions **queue**; anything mid-grade is requeued, not failed. The
  ordered sequence, with what to check afterwards, is `docs/runbook.md`,
  *Rotating a judge's token*. The token reaches three consumers that must all
  agree — the comment above it in `.env` names them.
- **`.secrets/duckadmin.txt`** — the rehearsal admin's password. Step 4
  deletes that account, or change the password; either way **delete the file**.

**Done when:** `.secrets/` is empty, no value in `.env` matches its old one,
and the stack is `healthy` again.

### 2. Point SMTP at a real relay

Without `SMTP_HOST` the API **logs mail instead of sending it** (D1) — but it
is not silent about it (D155, F-40): it warns at boot, `GET /readyz` answers
`"mail": "log"`, the **Mail** panel on `/admin` reads *not configured*, and
under `NODE_ENV=production` a password-reset request is **refused 503
`mail_unavailable`** rather than telling a teacher a message was sent. A pupil
who forgets their password still hears nothing back — the server just says so.

Since F-40 `docker-compose.yml` **does** pass all six — `SMTP_HOST`,
`SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` and
`MAIL_FROM` — into the `api` service, each defaulting to empty. There is
nothing to edit in `docker-compose.yml`: fill the values in `.env`, and set
`MAIL_FROM` to an address at the province's own domain (the default
`no-reply@duckoj.local` is what real relays reject).

**Done when:** the **Mail** panel on `/admin` reads *SMTP* rather than *not
configured*, the **Send a test message** button beneath it succeeds, and a test
account's password reset arrives in a real inbox, not in the spam folder.

### 3. Set the origins and the two policy switches

`SITE_ADDRESS` is what Caddy gets a certificate for; `PUBLIC_ORIGIN` is the
origin the API claims, used in mail links and the CSRF check (D82);
`WS_EXTRA_ORIGINS` **must be empty**. On the rehearsal host it carries
`localhost` so Playwright can open `/ws` (D70) — leaving it set keeps an origin
hole open for any browser on the server.

**Two switches decide what this province publishes and who may come in.** Both
are passed into `api` unconditionally and default to **empty**, and empty means
the protective rung, whose value lives in the schema rather than in `.env`.
**Setting nothing is itself a decision** — make it deliberately.

- **`NAME_DISCLOSURE`** (D197) — who may read a **real display name**. On a
  provincial host that is very often a twelve-year-old's full name, because the
  roster came out of a school's spreadsheet (D61).
  `affiliated` is the **default**: real names go to a reader with standing (an
  admin, a setter, anyone holding a role in any organization, and always the
  account itself), while a stranger and a minutes-old account see the
  **username** in the display-name field — nothing is blanked.
  `authenticated` gives real names to any signed-in caller, which costs exactly
  what making an account costs. `public` gives them to anonymous strangers:
  DuckOJ's pre-D197 behaviour, right only for an adult public judge.
- **`REGISTRATION`** (D200) — who may **create an account**. `closed` is the
  **default**: `POST /auth/register` answers 403 to everyone but a global
  admin, and `/register` says so instead of letting someone fill five fields
  first. Stated plainly, `closed` costs a school that wants pupils to enrol
  themselves — it has to import them instead (`corepack pnpm org:import`, D61);
  there is no invitation-code rung. `open` is the pre-D200 behaviour, metered
  by D26, and it is the rung you opt into.

Changing `NAME_DISCLOSURE` changes only what is **disclosed**: no name is
edited, nothing is migrated, and setting it back restores the old behaviour at
once.

**Done when:** the real hostname serves TLS, a submitted solution shows its
verdict **without a page reload**, `WS_EXTRA_ORIGINS` is blank, and the
**Operations** panel on `/admin` — *Runtime configuration* — shows the two rungs
you meant to set. That panel reads what the running process actually got, which
is the only proof a value in `.env` reached it (F-40's lesson).

### 4. Run the cleanup

```
corepack pnpm tsx scripts/cleanup-test-data.ts            # dry run, changes nothing
CONFIRM=yes corepack pnpm tsx scripts/cleanup-test-data.ts --apply
```

The dry run is the default and Postgres enforces it: the transaction opens
read-only and ends in `ROLLBACK`. It prints three things, and all three must be
read before typing `CONFIRM=yes` — the full inventory in foreign-key order, the
rows it **refuses** because a kept row depends on them, and what kept rows lose
anyway. `--print-plan` writes the exact SQL to stdout without connecting.

Classification is by **name only**, against a fixed prefix list; the demo set
(`duckadmin`, `hocsinh1`, the five Vietnamese problems, `thu-nghiem-1`) is a
deny-list the patterns cannot reach. See D153 for what counts as a test
artefact and why deletion is opt-in. Keep the demo set for teacher training,
or remove it by hand from the Admin page **after** step 6.

**Done when:** a second dry run reports `0 rows` and
`corepack pnpm tsx scripts/integrity-check.ts --live` is clean.

### 5. Prove the backups restore

A backup that has never been reloaded is not a backup. Measured, not
hypothetical: the newest nightly dump would **not** load onto a running stack,
because today's schema has tables the dump has never heard of (D130).

Run D130's drill — a throwaway compose project built from the current images,
`CONFIRM=yes scripts/restore.sh <prefix>`, then count rows. Runbook,
_Restoring_. Never drill on production. Install
`deploy/duckoj-backup.timer` (runbook, _Boot and reboot_) and **copy backups
off this host**: the timer keeps 14 nightly dumps on the disk that will fail
with it (D17).

**Done when:** `pg_restore` reports **zero** errors on the throwaway project,
the row counts match, and one copy lives on another machine.

### 6. Mint the real first administrator

`corepack pnpm bootstrap:admin <name> --email <address>` — see
`docs/guide/quan-tri.md` §1 and the runbook's _Bootstrapping the first admin_,
which carries the `podman run` line for a Postgres with no published port.
Once per database; everything after that happens in the web UI.

**Done when:** that account signs in, `/admin` opens, and the
printed-once password is in the province's secret store rather than a file in
the checkout.

### 7. Import the real problems

`content/README.md` for a directory of prepared problems,
`corepack pnpm polygon:import` for a Polygon package,
`corepack pnpm prepare:problem` for the one-command publish (D90, D97); the
detail is in `docs/guide/chuan-bi-de.md`. Class rosters go in with
`corepack pnpm org:import` (D61, runbook _Bulk student accounts for a
school_) — those accounts must change their password on first sign-in (D102).

**Done when:** every real problem has accepted a model solution from the real
judge, not from a cache.

### 8. The "you are live" smoke checks

In this order, over the **real hostname**, on a **phone**, not on the server:

1. Front page — a round happening now appears at the top (D151).
2. Register a new account → the confirmation mail actually arrives (§2). If
   you left `REGISTRATION` empty (the default, D200) this step **must** answer
   403 and `/register` must say why — that is the correct result. Make the test
   account with `corepack pnpm org:import` or as the administrator instead, and
   carry on to step 3 with it.
3. Submit → the verdict arrives on its own (§3); if the live channel is
   blocked, the page falls back to polling every four seconds and **says so**
   (D152).
4. Open a contest, enter it, read the scoreboard.
5. `corepack pnpm tsx scripts/integrity-check.ts --live` → clean.
6. `/admin` → the Operations panel: queue empty, judge connected.
7. Reboot the host. The stack comes back on its own (runbook, _Boot and
   reboot_).

**Done when:** all seven pass in **one run**, after a reboot.

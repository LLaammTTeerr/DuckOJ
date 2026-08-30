# Hướng dẫn cho quản trị viên

Dành cho người vận hành máy chủ DuckOJ: dựng quản trị viên đầu tiên, theo dõi
hệ thống, phân quyền, cứu tài khoản, sao lưu và khôi phục.

Hướng dẫn này nói về **màn hình quản trị trong web** và những **lệnh chạy trên
máy chủ**. Chi tiết vận hành đầy đủ nằm ở `docs/runbook.md`; các quyết định
thiết kế nằm ở `docs/DECISIONS.md`.

## 1. Quản trị viên đầu tiên

Trên một cơ sở dữ liệu mới chưa có ai là quản trị viên, không có đường nào
trong web tự cấp quyền cho mình. Dùng lệnh:

```
DATABASE_URL=postgres://duckoj:...@localhost:5432/duckoj \
  corepack pnpm bootstrap:admin tenban --email ban@example.com
```

- Tài khoản chưa tồn tại thì được **tạo mới**, mật khẩu băm đúng như khi đăng
  ký, và **địa chỉ email được đánh dấu đã xác nhận** — nhờ vậy một máy chủ
  chưa cấu hình SMTP vẫn vào được.
- Tài khoản đã tồn tại thì **chỉ được nâng quyền**; mật khẩu và email giữ
  nguyên.
- Không truyền `--password` thì hệ thống sinh một mật khẩu và **in ra đúng một
  lần**. Lưu ngay, không có cách lấy lại.
- `--email` mặc định là `<tên>@bootstrap.local`, đổi được sau ở trang cài đặt.

Khi cả stack đang chạy dưới compose, Postgres không mở cổng ra ngoài, nên chạy
lệnh này trong một container dùng một lần — xem `docs/runbook.md`, mục
*Bootstrapping the first admin*, có sẵn dòng lệnh `podman run` đầy đủ.

Chỉ cần làm **một lần cho mỗi cơ sở dữ liệu**. Từ đó trở đi mọi việc cấp quyền
diễn ra trong web.

## 2. Trang Quản trị

Đăng nhập bằng tài khoản quản trị viên rồi mở **Quản trị** (`/admin`) trên
thanh điều hướng — mục này chỉ hiện với quản trị viên. Trang gồm bốn phần,
theo thứ tự: **Vận hành**, **Cấp quyền toàn hệ thống**, **Đặt lại xác thực hai
bước**, **Kỳ thi tính rating**.

## 3. Bảng vận hành

Phần **Vận hành** là **ảnh chụp trực tiếp, làm mới mỗi 15 giây, không lưu
đệm**, kèm giờ cập nhật. Sáu mảng:

**Hàng đợi chấm** — *Đang chờ*, *Đang chấm*, *Lượt thuê hết hạn*, *Thất bại*,
*Chờ lâu nhất*. Nút **Đưa lại vào hàng đợi** chuyển mọi công việc có lượt thuê
đã hết hạn về trạng thái chờ **và tăng số lần thử**, nhờ đó một máy chấm còn
sót lại không ghi được kết quả cũ vào. Lượt thuê còn hiệu lực không bị đụng
tới. Không có gì hết hạn thì nút báo lại đúng như vậy.

**Máy chấm** — mỗi dòng là một tiến trình DMOJ đã đăng ký: trình điều khiển,
lần cuối thấy, và trạng thái *trực tuyến* / *ngoại tuyến* (im lặng quá 90 giây
là ngoại tuyến).

**Tiến trình chấm** — các vòng nhận việc của `judged`: đang chấm gì, đã chấm
bao nhiêu trong một giờ, bao nhiêu lỗi hệ thống trong một giờ. Hai bảng này
**không liên quan nhau**: một bên là máy chấm, một bên là vòng nhận việc.

**Lỗi hạ tầng gần đây** — các lỗi hệ thống và bài nộp mà đường ống chấm bỏ dở.
*Kết quả sai của thí sinh không phải lỗi và không nằm ở đây.*

**Lượt bị chặn bởi giới hạn tần suất (1 giờ)** — bao nhiêu lần đăng nhập, đăng
ký, hỏi đáp… bị chặn, theo từng mục đích. Một cột tăng vọt là dấu hiệu đáng
xem: có thể là dò mật khẩu, cũng có thể là cả phòng thi cùng bấm.

**Cấu hình đang chạy** — Cơ sở dữ liệu và Redis (*hoạt động* / *không kết nối
được*), số **Tiến trình API** và **Số luồng chấm**. *Không được báo* nghĩa là
tiến trình API không được truyền biến đó, không phải bằng 1.

## 4. Phân quyền

**Cấp quyền toàn hệ thống**: nhập **tên đăng nhập**, chọn vai trò, bấm **Cấp**.

| Vai trò | Làm được gì |
| --- | --- |
| *người dùng* | mặc định: nộp bài, dự thi |
| *người ra đề* | thêm: tạo bài tập, tạo kỳ thi |
| *quản trị viên* | thêm: mọi thứ trong hướng dẫn này |

Người được cấp nhận một thông báo trong ứng dụng.

Cấp quyền **người ra đề** là việc thường xuyên nhất: giáo viên cần nó để ra đề
và tổ chức kỳ thi. Cấp **quản trị viên** thì dè dặt — vai trò đó bỏ qua mọi
lớp kiểm soát về phạm vi, đọc được mọi bài nộp và mọi bảng điểm không đóng
băng.

Hai việc chỉ quản trị viên làm được và hay bị hỏi tới:

- **Tạo tổ chức** — biểu mẫu **Tổ chức mới** ở trang `/orgs` chỉ hiện với
  quản trị viên. Người tạo trở thành **chủ sở hữu**; hãy chuyển vai trò chủ sở
  hữu cho giáo viên phụ trách ở bảng **Thành viên** sau khi họ đã gia nhập.
- **Chấm lại** — nút **Chấm lại** trên trang một bài nộp, và **Chấm lại toàn
  bộ bài nộp** ở cuối màn sửa bài. Chấm lại **không tự tính lại rating**: hệ
  thống trả về danh sách kỳ thi cần tính lại, và bạn phải làm bước đó bằng tay
  ở mục **Kỳ thi tính rating**.

**Kỳ thi tính rating**: bảng mọi kỳ thi với nút **Bật tính rating** / **Tắt
tính rating**. Cảnh báo trên màn hình là thật: **mỗi lần bật hoặc tắt đều tính
lại toàn bộ rating từ đầu**, nên hồ sơ của nhiều người thay đổi chứ không
riêng kỳ thi vừa bấm. Xong việc, hệ thống báo hiện có bao nhiêu kỳ thi đang
tính vào rating.

## 5. Đặt lại xác thực hai lớp

Dùng khi một người mất thiết bị xác thực **và** mất luôn mã khôi phục.

1. Nhập **tên đăng nhập** vào ô *Người dùng cần đặt lại*.
2. Bấm **Tắt xác thực hai bước** và xác nhận.
3. Sau đó tài khoản chỉ cần mật khẩu để đăng nhập, và họ tự bật lại được ở
   trang **Bảo mật**.

**Xác minh danh tính người yêu cầu trước.** Thao tác này gỡ một lớp bảo vệ
khỏi tài khoản của người khác, và bản thân người đó sẽ nhận được thông báo
"Quản trị viên đã tắt xác thực hai bước trên tài khoản của bạn" — nên một lần
đặt lại sai người là một lần bị phát hiện.

Hãy hỏi hai câu trước khi bấm: *đã thử mã khôi phục chưa?* (mỗi người có tám
mã, cấp lúc bật xác thực hai lớp) và *có tự tạo bộ mã mới được không?* Chỉ khi
cả hai đều không, đây mới là phương án cuối. (Dòng ghi chú trên màn hình còn
viết theo thời chưa có mã khôi phục — nội dung thao tác thì vẫn đúng.)

## 6. Sao lưu

Hai thứ không dựng lại được trên máy này: **cơ sở dữ liệu Postgres** và
**volume `package_store`** chứa các gói bài. Mọi thứ khác đều dựng lại được.

```
scripts/backup.sh                 # -> ~/duckoj-backups
scripts/backup.sh /mnt/usb/duckoj
```

Mỗi lần chạy ghi `duckoj-<dấu-thời-gian>.dump` và
`duckoj-<dấu-thời-gian>.package_store.tar`, in kích thước, rồi xoá bớt chỉ giữ
`KEEP` bản mới nhất (mặc định **14**). Cả hai tệp được ghi ra `.partial` và chỉ
đổi tên khi lệnh tạo ra chúng kết thúc thành công — thư mục sao lưu không bao
giờ chứa tệp cụt mang tên nghe như dùng được.

**Bản sao lưu chứa bảng người dùng** — băm mật khẩu, email và họ tên của học
sinh vị thành niên, bí mật xác thực hai lớp đã mã hoá. Không có mã hoá khi
lưu; thứ duy nhất bảo vệ chúng là quyền tệp:

```
~/duckoj-backups            drwx------   (700)
~/duckoj-backups/duckoj-*   -rw-------   (600)
```

Script tự siết lại quyền mỗi lần chạy. **Nếu `ls -l ~/duckoj-backups` hiện
quyền khác, có thứ ngoài script đã ghi vào đó — phải điều tra.** Khi chép bản
sao lưu ra ngoài, nhớ rằng `scp` không giữ quyền 700 nếu thư mục cha mở.

Chạy từ một git worktree thì phải truyền `COMPOSE_PROJECT_NAME=duckoj`, nếu
không script không tìm thấy container và dừng với thông báo đúng như vậy.

### Sao lưu hằng đêm

Bộ hẹn giờ `duckoj-backup.timer` chạy lúc **03:00 giờ Việt Nam** (múi giờ được
ghi thẳng vào biểu thức), và `Persistent=true` khiến lần khởi động đầu sau một
đêm tắt máy vẫn chạy bù.

```
systemctl --user list-timers duckoj-backup.timer   # NEXT / LEFT / LAST / PASSED
journalctl --user -u duckoj-backup -n 50           # đầu ra của backup.sh
systemctl --user start duckoj-backup.service       # chạy ngay, không chờ 03:00
```

`LAST` là `n/a` trên một máy đã bật hơn một ngày nghĩa là bộ hẹn giờ **chưa hề
chạy** — kiểm tra `enable` và `loginctl enable-linger`.

Ba điều phải biết:

- **Không có gì báo động khi sao lưu hỏng.** Một bản `pg_dump` bắt đầu thất
  bại chỉ hiện trong nhật ký. Phải có người nhìn.
- Bộ hẹn giờ **không tự dựng lại stack**: stack bị dừng có chủ đích thì cứ
  dừng, và `backup.sh` báo lỗi to.
- **14 bản đều nằm trên chính máy này.** Chép ra nơi khác là việc đơn vị vận
  hành phải tự làm — máy cháy thì cả 14 bản cùng cháy.

## 7. Khôi phục

```
CONFIRM=yes scripts/restore.sh ~/duckoj-backups/duckoj-20260829-030000
```

- Không có `CONFIRM=yes` thì script **từ chối chạy** — không có câu hỏi tương
  tác, để nó thất bại chứ không treo khi chạy trong shell không người trực.
- Truyền **tiền tố** của cặp tệp sao lưu, không phải một tệp cụ thể.
- Chạy từ worktree: lại phải có `COMPOSE_PROJECT_NAME=duckoj`, và ở đây sự
  khác biệt là nguy hiểm — đọc kỹ mục *Restoring* trong `docs/runbook.md`
  trước lần khôi phục thật đầu tiên.
- Khi một bước thất bại và cơ sở dữ liệu chưa được kiểm chứng, script **để các
  tiến trình ghi ở trạng thái dừng**; kiểm chứng xong mới khởi động lại. Đừng
  tự tay bật chúng lên trước khi hiểu vì sao script dừng.

Chưa có lần khôi phục thật nào được diễn tập trên máy chủ đang chạy. Hãy diễn
tập một lần vào lúc rảnh, đừng để lần đầu tiên rơi vào lúc sự cố.

## 8. Theo dõi hàng đợi chấm

Hai trần khác nhau, rất hay bị nhầm:

- **`JUDGED_CONCURRENCY`** — số vòng nhận việc trong tiến trình `judged`
  (mặc định 1, tối đa 16), đặt trong `.env`.
- **Số container máy chấm** — trần thật. Một máy chấm DMOJ **chấm một bài mỗi
  lần**, nên năng lực của cả cụm bằng số máy chấm đang kết nối. Hiện có một.

Hệ quả: **nâng `JUDGED_CONCURRENCY` quá số máy chấm không đem lại gì** — các
vòng thừa không bao giờ giành được chỗ. Nâng cùng lúc với việc thêm máy chấm.
Và **không có máy chấm nào kết nối thì không việc nào được nhận**: bài nộp nằm
ở *Đang chờ*, hết 300 giây thì hoá `IE`.

Hàng đợi không nhúc nhích, theo thứ tự này:

1. Bảng **Máy chấm** trên trang quản trị — có dòng nào *trực tuyến* không?
2. `podman logs duckoj_judged_1` — có bắt tay với máy chấm không?
3. *Lượt thuê hết hạn* > 0 → bấm **Đưa lại vào hàng đợi**.
4. `podman ps` — container nào chết?

Trước một kỳ thi quy mô tỉnh, **thêm một container máy chấm thứ hai** —
`docs/runbook.md`, mục *Adding a second judge container*, ghi từng bước (mỗi
máy chấm cần một `JUDGE_TOKEN` riêng: `judge_nodes` có ràng buộc duy nhất trên
băm của token).

## 9. Nhật ký và khởi động lại

```
systemctl --user status duckoj          # "active (exited)" là ĐÚNG
journalctl --user -u duckoj -n 100      # lần dựng gần nhất
journalctl --user -u duckoj -b          # chỉ lần khởi động này
podman ps                               # cái gì đang chạy
podman logs duckoj_judged_1             # nhật ký một container
```

`Type=oneshot` kèm `RemainAfterExit=yes` nên một unit khoẻ mạnh hiện **`active
(exited)`**, không phải `active (running)`. Đó không phải lỗi: container do
podman trông, còn unit chỉ có nhiệm vụ chạy `compose-up.sh` thành công một
lần. Nếu unit `failed`, nhật ký giữ dòng `FATAL:` của script.

`systemctl --user stop duckoj` là cách tắt trang có chủ đích.

**Sau mỗi lần thay đổi mã nguồn, phải triển khai lại bằng tay:**

```
cd ~/Projects/duckoj && git pull
scripts/compose-up.sh          # không đặt SKIP_BUILD — lần này có build lại
```

`systemctl --user restart duckoj` **không phải** là triển khai lại: unit khởi
động chạy với `SKIP_BUILD=1` và sẽ dựng lại stack từ ảnh cũ — trang báo khoẻ
mạnh trong khi vẫn chạy mã cũ.

## 10. Những gì đơn vị vận hành phải tự lo

1. **SMTP** (`SMTP_*` trong `.env`) — thiếu nó thì thư xác nhận địa chỉ và thư
   đặt lại mật khẩu **âm thầm không được gửi**, không báo lỗi ở đâu cả.
2. **Tên miền công khai và TLS** (`SITE_ADDRESS`, `PUBLIC_ORIGIN`).
3. **Bản sao lưu để ở nơi khác** — xem mục 6.
4. **Máy chấm thứ hai** trước kỳ thi lớn — xem mục 8.

## English

For whoever runs the DuckOJ server: minting the first administrator,
monitoring, granting roles, rescuing accounts, backups and restores. The full
operational detail lives in `docs/runbook.md`; the design rulings in
`docs/DECISIONS.md`.

### 1. The first administrator

A fresh database has no path in the web UI to make anyone an administrator.
Use the CLI against `DATABASE_URL`:

```
DATABASE_URL=postgres://duckoj:...@localhost:5432/duckoj \
  corepack pnpm bootstrap:admin yourname --email you@example.com
```

It **creates** the account if it does not exist — same argon2id hashing as
registration, with the address marked verified so a server without SMTP is not
locked out — and **only promotes** if it does, leaving password and address
alone. Without `--password` one is generated and **printed once**; store it
immediately. `--email` defaults to `<username>@bootstrap.local`. Under compose,
Postgres publishes no host port, so run this as a one-off container — the exact
`podman run` line is in the runbook under *Bootstrapping the first admin*. This
is needed **once per database**; every later grant happens in the web UI.

### 2. The Admin page

**Admin** (`/admin`) appears in the nav for administrators only, and holds four
sections in this order: **Operations**, **Grant a global role**, **Reset
two-factor**, **Rated contests**.

### 3. The operations dashboard

One **live snapshot, refreshed every 15 seconds, nothing cached**, with the
time of the last update. Six panels:

**Grading queue** — queued, running, expired leases, failed, oldest wait. The
**Requeue** button moves every job whose lease has expired back to queued **and
bumps its attempt**, so a straggling judge can no longer write a result for it;
live leases are untouched, and with nothing expired the button says so.

**Judges** — one row per registered DMOJ process, with its driver, last-seen
time and *online* / *offline* status (silent for 90 seconds counts as offline).

**Grading workers** — `judged`'s claim loops: what each is grading, how many it
graded in the last hour, how many internal errors. Judges and workers are two
different things and do not join.

**Recent infrastructure failures** — internal errors and submissions the
pipeline abandoned. A competitor's wrong answer is not a failure and is not
listed here.

**Rate-limit refusals (1 hour)**, by purpose. A spike is worth a look: it is
either someone probing passwords or a whole exam room pressing at once.

**Runtime configuration** — database and Redis reachability, the API worker
count and the judging concurrency. *Not reported* means the API process was
never told, which is not the same as 1.

### 4. Granting roles

**Grant a global role**: a username, a role, **Grant**. *user* is the default;
*setter* adds creating problems and contests; *admin* adds everything in this
guide. The recipient is notified in-app. Granting **setter** is the routine
case — teachers need it to set problems and run contests. Grant **admin**
sparingly: it bypasses every visibility rule, reads every submission, and sees
every scoreboard unfrozen.

Two administrator-only jobs people will ask you for: **creating an
organisation** (the **New organization** form on `/orgs` is administrator-only;
the creator becomes owner, so hand ownership to the teacher in the **Members**
table once they have joined), and **rejudging** (per submission from its page,
or every submission of a problem from the bottom of its edit screen). **A
rejudge never replays ratings** — it names the contests that need re-rating and
you do that by hand.

**Rated contests** lists every contest with **Rate** / **Unrate**. The warning
on screen is literal: **each toggle recomputes every rating from scratch**, so
many people's profiles move, not just this contest's.

### 5. Resetting two-factor authentication

For someone who has lost their authenticator **and** their recovery codes.
Type the **username**, press **Turn two-factor off**, confirm. They can then
sign in with a password alone and re-enable it themselves on the Security page.

**Verify who is asking first.** This removes a protection from someone else's
account, and they are notified that an administrator did it — so a reset done
for the wrong person is a reset that gets noticed. Ask two questions before
pressing: *have you tried a recovery code?* (everyone gets eight when they
enable two-factor) and *can you generate a fresh set?* Only if both fail is
this the last resort. (The on-screen note still reads from before recovery
codes existed; the operation it describes is unchanged.)

### 6. Backups

Two things here cannot be rebuilt: the Postgres database and the
`package_store` volume of problem packages. `scripts/backup.sh [dir]` captures
exactly those (default `~/duckoj-backups`), writing a `.dump` and a
`.package_store.tar` per run, printing their sizes, and pruning to the newest
`KEEP` (default **14**). Both are written as `.partial` and renamed only on
success, so the directory never holds a truncated file under a usable name.

**A dump contains the identity table** — password hashes, the addresses and
names of pupils who are minors, encrypted TOTP secrets. There is no encryption
at rest; file modes are the only protection (`700` on the directory, `600` on
the files, re-tightened on every run). **If `ls -l ~/duckoj-backups` ever shows
anything else, something outside these scripts wrote there — investigate.**
`scp` does not preserve a 700 directory into a world-readable parent. From a
git worktree, pass `COMPOSE_PROJECT_NAME=duckoj`.

Nightly, `duckoj-backup.timer` fires at **03:00 Asia/Ho_Chi_Minh** (the zone is
written into the expression) and `Persistent=true` catches up after a night
powered off. Check it with `systemctl --user list-timers duckoj-backup.timer`
and `journalctl --user -u duckoj-backup -n 50`; force one with `systemctl
--user start duckoj-backup.service`. A `LAST` of `n/a` on a host up for more
than a day means it has never fired — check the timer is enabled and lingering
is on.

Three things to know: **nothing alerts you when a backup fails** — someone has
to look; the timer will **not** restart a stack you stopped on purpose; and all
14 copies live on this one host, so **copying them off-host is your job**.

### 7. Restoring

```
CONFIRM=yes scripts/restore.sh ~/duckoj-backups/duckoj-20260829-030000
```

It refuses to run without `CONFIRM=yes` — there is no prompt, so it fails
rather than hangs unattended. Pass the **prefix** of the pair, not one file.
From a worktree it again needs `COMPOSE_PROJECT_NAME=duckoj`, and here the
difference is dangerous — read the runbook's *Restoring* section before your
first real restore. When a step fails and the database is left unverified, the
script **leaves the writers stopped**; do not start them by hand before you
understand why. No real restore has yet been rehearsed against the live stack:
rehearse one on a quiet day rather than discovering it during an incident.

### 8. Watching the grading queue

Two ceilings, commonly confused. `JUDGED_CONCURRENCY` (`.env`, default 1, max
16) is how many claim loops `judged` runs. The **number of connected judge
containers** is the real ceiling: a DMOJ judge grades **one submission per
connection**, and there is one container. So **raising `JUDGED_CONCURRENCY`
past the number of judges does nothing** — the extra loops never win a slot —
and **with no judge connected nothing is claimed at all**: submissions sit
queued and time out as `IE` after 300 s.

When the queue stalls, in order: the **Judges** panel (anything *online*?);
`podman logs duckoj_judged_1` (any handshake?); expired leases > 0 → press
**Requeue**; `podman ps` (anything dead?). Before a province-scale contest, add
a **second judge container** — the runbook's *Adding a second judge container*
has the steps, and each judge needs its own `JUDGE_TOKEN` because `judge_nodes`
is unique on the token hash.

### 9. Logs and restarts

```
systemctl --user status duckoj          # "active (exited)" is CORRECT
journalctl --user -u duckoj -n 100      # the last bring-up
journalctl --user -u duckoj -b          # this boot only
podman ps
podman logs duckoj_judged_1
```

`Type=oneshot` plus `RemainAfterExit=yes` means a healthy unit reads **`active
(exited)`**, not `active (running)`; the containers are supervised by podman,
and the unit's job is only to have run `compose-up.sh` once. A `failed` unit's
journal holds the script's `FATAL:` line. `systemctl --user stop duckoj` is how
you take the site down deliberately.

**After any code change, redeploy by hand:**

```
cd ~/Projects/duckoj && git pull
scripts/compose-up.sh          # no SKIP_BUILD — this one rebuilds
```

`systemctl --user restart duckoj` is **not** a redeploy: the boot unit runs
with `SKIP_BUILD=1` and brings the stack back from the old images, reporting
healthy while serving the previous build.

### 10. What the operator must supply

1. **SMTP** (`SMTP_*` in `.env`) — without it, verification and password-reset
   mail is **silently not sent**, with no error anywhere.
2. **A public hostname and TLS** (`SITE_ADDRESS`, `PUBLIC_ORIGIN`).
3. **Off-host copies of the backups** — see §6.
4. **A second judge container** before a large contest — see §8.

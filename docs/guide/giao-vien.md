# Hướng dẫn cho giáo viên

Dành cho người tổ chức thi và giao bài: lập tổ chức của trường, tạo tài khoản
cho học sinh, ra kỳ thi, trực phòng thi và đọc kết quả.

## 0. "Giáo viên" là những quyền nào

DuckOJ không có vai trò *giáo viên*. Việc bạn làm được phụ thuộc vào ba thứ:

| Cái bạn cần | Ai cấp | Cho phép |
| --- | --- | --- |
| Quyền toàn hệ thống **người ra đề** (`setter`) | quản trị viên | tạo bài tập, tạo kỳ thi |
| **Chủ sở hữu** tổ chức của trường | quản trị viên (người tạo tổ chức) | nhập danh sách học sinh, giới hạn kỳ thi cho trường, đổi vai trò thành viên |
| Là **người tạo** kỳ thi | chính bạn, khi tạo kỳ thi | sửa kỳ thi, trả lời hỏi đáp, đăng thông báo, hủy tư cách, xem bảng điểm không đóng băng |

Hai việc **chỉ quản trị viên** làm được, dù bạn là người ra đề: **tạo tổ
chức** và **chấm lại** bài nộp. Xem mục 7.

## 1. Tổ chức của trường

**Tổ chức** (`/orgs`) là danh sách trường, câu lạc bộ, đội tuyển.

Chỉ **quản trị viên** thấy biểu mẫu **Tổ chức mới**. Nhờ quản trị viên tạo
tổ chức với:

- **Định danh** — chuỗi ngắn không dấu dùng trong đường dẫn, ví dụ `thpt-abc`.
- **Tên**, **Cách gia nhập** (*tự do* / *cần duyệt* / *chỉ theo lời mời*),
  **Phạm vi** (*công khai* / *riêng tư*).

**Người tạo tổ chức trở thành chủ sở hữu.** Để bạn tự chủ trì được, hãy gia
nhập tổ chức rồi nhờ quản trị viên (hoặc chủ sở hữu hiện tại) đổi **Vai trò**
của bạn thành *chủ sở hữu* ở bảng **Thành viên**. Chỉ chủ sở hữu và quản trị
viên toàn hệ thống đổi được vai trò, và tổ chức không bao giờ bị bỏ trống chủ
sở hữu cuối cùng.

Trên trang một tổ chức:

- **Yêu cầu gia nhập** — hàng chờ với nút **Duyệt** / **Từ chối**, hiện cho
  chủ sở hữu và quản trị viên của tổ chức.
- **Thành viên** — đổi **Vai trò** (*chủ sở hữu* / *quản trị viên* / *thành
  viên*) hoặc **Xóa**.
- **Kỳ thi** — các kỳ thi gắn với tổ chức này.

## 2. Nhập danh sách học sinh

Mục **Nhập danh sách học sinh** nằm trên trang tổ chức và **chỉ hiện với chủ
sở hữu tổ chức hoặc quản trị viên toàn hệ thống** — quản trị viên *của tổ
chức* không đủ quyền.

Định dạng: mỗi học sinh một dòng gồm **tên đăng nhập, họ tên, và email nếu
có**. Dòng tiêu đề là tuỳ chọn. **Tối đa 2000 dòng mỗi lần.** Dán thẳng vào ô
**Danh sách học sinh** hoặc **Chọn tệp CSV**.

1. Bấm **Kiểm tra danh sách** — chạy thử, không tạo gì. Sai ở đâu thì bảng lỗi
   chỉ rõ **Dòng**, **Trường** và **Lỗi**; đúng hết thì hiện bản xem trước và
   dòng *Sẽ tạo n tài khoản*.
2. Sửa cho sạch rồi bấm **Tạo tài khoản**.

Quy tắc phải nhớ:

- **Một dòng sai là không dòng nào được tạo.** Hoặc cả danh sách, hoặc không
  gì cả.
- **Mật khẩu chỉ hiện một lần.** Sau khi tạo, bảng tài khoản có nút **In**,
  **Tải CSV** và một ô văn bản để sao chép. Không có cách nào lấy lại về sau —
  in hoặc lưu ngay.
- **Mỗi học sinh phải tự đặt mật khẩu riêng khi đăng nhập lần đầu**; hệ thống
  chặn mọi trang khác cho tới khi họ đổi.
- Học sinh **không có email** vẫn dùng được mọi thứ, nhưng địa chỉ của họ là
  địa chỉ giả nội bộ, nên **không dùng được "Quên mật khẩu?"**. Mất mật khẩu
  thì phải nhờ quản trị viên.
- Chỉ **một lần nhập thật mỗi tổ chức mỗi phút** (bấm *Kiểm tra danh sách*
  bao nhiêu lần cũng được).
- Với lớp rất đông, thao tác này chậm (mỗi tài khoản là một lần băm mật
  khẩu) — đừng đóng tab giữa chừng.

Có thể chạy từ dòng lệnh trên máy chủ: `corepack pnpm org:import` (xem
`docs/runbook.md`, mục *Bulk student accounts for a school*).

## 3. Tạo kỳ thi

Cần quyền **người ra đề** trở lên: khi đó trang **Kỳ thi** hiện nút **Kỳ thi
mới**.

- **Mã kỳ thi** — chuỗi ngắn trong đường dẫn, ví dụ `hsg-2026`.
- **Tên**.
- **Bắt đầu**, **Kết thúc** — nhập theo **múi giờ của chính máy bạn**.
- **Thể thức** — `icpc`, `ioi16`, `legacy_ioi` hoặc `default`. Đây là từ vựng
  của hệ thống chấm nên không dịch.
- **Đóng băng (phút)** — số phút cuối kỳ thi mà bảng điểm ngừng cập nhật. Phải
  là số nguyên và **ngắn hơn cả kỳ thi**. Để trống hoặc `0` là không đóng băng.
- **Phạm vi** — *công khai*, *theo tổ chức* hoặc *riêng tư*: ai **nhìn thấy**
  kỳ thi.
- **Giới hạn theo tổ chức** — ai được **vào thi**. Xem mục 4.
- Bảng **Bài tập**: mỗi dòng gồm **Mã** bài, **Điểm** và **Điểm thành phần**
  (cho phép ăn điểm từng test). Bấm **Thêm bài** để có thêm dòng.

Bấm **Tạo kỳ thi**.

Sửa về sau: trên trang kỳ thi bấm **Sửa kỳ thi**. Sau khi kỳ thi đã bắt đầu:

- **Không xoá được bài khỏi kỳ thi** — hệ thống từ chối, vì xoá sẽ kéo theo
  mọi bài nộp của bài đó.
- Thêm bài, đổi điểm, đổi nhãn thì vẫn được.
- **Thời điểm bắt đầu bị khoá; thời điểm kết thúc thì không** — nới thêm giờ
  cho cả phòng thi là việc làm được giữa chừng.

## 4. Giới hạn kỳ thi cho trường mình

Ô **Giới hạn theo tổ chức** ở màn tạo và sửa kỳ thi:

- Không chọn tổ chức nào → **ai nhìn thấy kỳ thi cũng vào thi được**.
- Chọn một hoặc nhiều tổ chức → **chỉ thành viên của các tổ chức đó** mới
  tham gia được; người khác bấm **Tham gia** sẽ bị từ chối và được cho biết
  kỳ thi dành cho tổ chức nào.
- Bạn **chỉ gắn được tổ chức mà mình là chủ sở hữu hoặc quản trị viên** —
  là thành viên thường thì chưa đủ. Tổ chức đã gắn sẵn từ trước vẫn giữ
  nguyên trong danh sách và vẫn lưu được.
- Tên tổ chức được **công khai trên trang kỳ thi** (kể cả tổ chức riêng tư) —
  một lời từ chối không nói rõ vì sao thì không ai hiểu.
- Rút một học sinh khỏi tổ chức giữa kỳ thi **không** xoá lượt thi đang có
  của em ấy; chỉ chặn việc tham gia mới.
- Quản trị viên toàn hệ thống được miễn. **Người tạo kỳ thi thì không** — tổ
  chức thi không phải là dự thi.

## 5. Trực phòng thi: thông báo và trả lời

Mục **Hỏi đáp / Thông báo** trên trang kỳ thi hiện thêm phần điều khiển cho
người tạo kỳ thi và quản trị viên:

- **Đăng thông báo** — viết vào ô *Điều gì mọi người cần biết?* rồi bấm
  **Đăng**. Thông báo công khai ngay và mọi thí sinh đã tham gia đều nhận được
  thông báo trong chuông.
- **Trả lời** một câu hỏi: gõ vào ô **Trả lời**. Người hỏi nhận được thông báo.
- **Công bố** câu hỏi kèm câu trả lời cho cả phòng thi — dùng khi câu hỏi có
  ích cho mọi người. Lúc đó mọi thí sinh đều nhận thông báo.

Lưu ý khi trực:

- Câu hỏi mặc định **chỉ người hỏi và ban tổ chức thấy**.
- Mỗi thí sinh hỏi tối đa **20 câu mỗi kỳ thi mỗi giờ**.
- Danh sách chỉ hiện **200 mục mới nhất**, và nói rõ khi đã cắt bớt.
- Trang tự làm mới mỗi 30 giây **trong lúc kỳ thi diễn ra**, không làm mới
  nữa khi đã kết thúc.
- **Phần hỏi đáp không chịu luật đóng băng.** Một câu trả lời nhắc tới kết quả
  cụ thể ("bài C của em `WA` test 3") sẽ lộ ra ngoài cả khi bảng điểm đang
  đóng băng. Đây là kỷ luật của người trực, hệ thống không chặn hộ.

## 6. Đóng băng bảng điểm

Đặt **Đóng băng (phút)** khi tạo kỳ thi. Trong khoảng đó:

- Thí sinh thấy **Bảng điểm đang đóng băng từ …**; ô của bài có lượt nộp chưa
  công bố hiện `?+n`.
- Kết quả bài nộp của **người khác** trong khoảng đóng băng bị ẩn ở cả trang
  bài nộp, chứ không riêng bảng điểm. Bài nộp vẫn hiện, chỉ kết quả bị giấu.
- Mỗi người luôn thấy đầy đủ **bài nộp của chính mình**.
- **Người tạo kỳ thi và quản trị viên luôn thấy bảng điểm thật**, không đóng
  băng — đó là bảng để đọc khi trao giải.
- Hết giờ của từng lượt thi thì mọi thứ tự hiện ra; thí sinh thi ảo vẫn bị
  giấu tới khi hết giờ của riêng họ.

Ngoài ra, **mã nguồn** bài nộp trong kỳ thi bị ẩn với người khác cho tới khi
lượt thi của người nộp kết thúc — chuyện này áp dụng cả khi không đóng băng.

## 7. Hủy tư cách và chấm lại

**Hủy tư cách** — trên **Bảng điểm**, mỗi dòng có nút **Hủy tư cách …** (và
**Khôi phục …** để bỏ). Chỉ người tạo kỳ thi và quản trị viên thấy nút này.
Dòng bị hủy tư cách vẫn hiện trên bảng, có ghi *(hủy tư cách)*. Việc hủy gắn
với **con người**, nên nếu người đó tham gia lại thì lượt mới vẫn bị hủy.

**Chấm lại — chỉ quản trị viên.** Không có nút này cho người ra đề. Nếu phát
hiện sai bộ test hay sai đề, hãy báo quản trị viên; họ có hai lựa chọn:

- một bài nộp: nút **Chấm lại** trên trang bài nộp;
- toàn bộ bài nộp của một bài: **Chấm lại toàn bộ bài nộp** ở cuối màn sửa bài.

Chấm lại **không tự tính lại rating**; hệ thống trả về danh sách kỳ thi cần
tính lại và quản trị viên phải làm bước đó bằng tay.

## 8. Xuất bảng điểm

DuckOJ **không có nút xuất bảng điểm**. Ba cách thường dùng:

1. **In trang Bảng điểm** (Ctrl/Cmd + P). Bản in đã tự bỏ thanh điều hướng,
   ra đúng cái bảng; chọn "Lưu thành PDF" nếu chỉ cần tệp.
2. **Chọn và sao chép** bảng vào bảng tính — bảng điểm là một `<table>` HTML
   thật, dán sang Excel/LibreOffice giữ nguyên cột.
3. **Gọi API**: tạo một **Mã truy cập** (`/account/tokens`) có phạm vi đọc rồi
   `GET /api/v1/contests/{key}/scoreboard`. Trang **API** trên thanh điều
   hướng có sẵn công cụ gửi thử. Cách này cho JSON, tiện để dựng báo cáo.

Danh sách bài nộp của riêng kỳ thi (liên kết **Tất cả bài nộp** trên trang kỳ
thi) lấy được theo đúng ba cách trên.

## 9. Bài tập và giao bài

Với quyền **người ra đề**, trang **Bài tập** có nút **Bài tập mới**. Màn soạn
bài có:

- **Mã**, **Tên**, **Đề bài** (Markdown, công thức viết trong `$…$`).
- **Phạm vi** và **Tổ chức (cách nhau bởi dấu phẩy)** — ai được đọc bài.
- **Quyền xem mã nguồn** — *Riêng tư* (chỉ người nộp, quản trị viên, tác
  giả/người phụ trách) hoặc *Đã giải* (thêm những ai đã có `AC`).
- **Chủ đề** và **Độ khó (1-10)**.
- **Lời giải** (Markdown, tiếng Việt và tiếng Anh) kèm ô **Xuất bản lời giải**.
  Người đang thi bài này chưa thấy lời giải, trừ khi đã `AC`; hết giờ thi thì
  ai cũng xem được.
- **Thành viên** — tác giả / người phụ trách / người thử nghiệm.

Giới hạn thời gian và bộ nhớ, cùng bộ test, đến từ **gói bài** tải lên ở trang
**Phiên bản**: tải gói, **Gắn** vào một phiên bản, rồi **Công bố**. Bài nộp
được chấm theo **phiên bản đang công bố lúc học sinh gửi**, nên công bố phiên
bản mới không làm hỏng kết quả cũ.

**Giao bài về nhà.** Không có mục "bài tập về nhà" riêng. Hai cách thực tế:

- **Kỳ thi dài ngày**, giới hạn cho tổ chức của trường (mục 3 và 4): có hạn
  nộp, có bảng điểm, có thống kê — gần với "bài tập có chấm điểm" nhất.
- **Đường dẫn danh sách bài đã lọc**: mở **Bài tập**, chọn **Chủ đề** và **Độ
  khó**, rồi sao chép nguyên địa chỉ trang gửi cho học sinh — bộ lọc nằm trong
  đường dẫn. Cột **Tôi** cho mỗi em biết bài nào mình đã giải.

## 10. Tải đề PDF

- **Cả kỳ thi trong một tệp**: nút **Tải đề (PDF)** trên trang kỳ thi. Tệp gồm
  trang bìa (tên kỳ thi, thời gian, giới hạn từng bài) rồi từng bài một, mỗi
  bài sang trang mới, đánh số trang, đánh nhãn `Bài A.`, `Bài B.`… Ngôn ngữ
  của tệp **theo ngôn ngữ bạn đang xem trang** — muốn bản tiếng Anh thì bấm
  **EN** trước.
- **Một bài**: liên kết **PDF** trên trang bài.
- Nút *Tải đề (PDF)* chỉ hiện khi đã có danh sách bài để in; **trước giờ thi**
  danh sách bài còn được giấu nên đường dẫn trả về "không có".
- Máy chủ không cài bộ dựng PDF thì hai đường dẫn này báo lỗi rõ ràng; nội
  dung bài tập vẫn đọc bình thường trên web.

Bản đề song ngữ: viết đề với một đề mục `## English` (hoặc `## Tiếng Việt`)
ngăn hai phần — đó là quy ước mà bộ dựng PDF dùng để tách ngôn ngữ.

## 11. Thống kê

Cuối trang mỗi bài có mục **Thống kê**: tổng lượt nộp, số người thử, số người
giải được, tỉ lệ được chấp nhận, và bảng **Người giải đầu tiên** kèm thời gian
và bộ nhớ. Danh sách **Bài tập** có thêm cột **Đã giải**.

Một điều phải biết khi đọc con số giữa kỳ thi: **một bài nộp chỉ được tính khi
lượt thi của người nộp đã kết thúc.** Vì vậy giữa giờ thi, thống kê và "người
giải đầu tiên" chưa phản ánh phòng thi đang chạy, và sẽ tự đúng lại khi hết
giờ. Số liệu này giống nhau với mọi người xem, kể cả quản trị viên.

Muốn theo dõi phòng thi ngay lúc đang thi thì dùng **Bảng điểm** (không đóng
băng với bạn) và **Tất cả bài nộp** của kỳ thi, chứ không phải mục Thống kê.

## English

For the people who run rounds and set work: your school's organisation,
student accounts, contests, invigilation, and reading results.

### 0. What "teacher" means here

DuckOJ has no *teacher* role. Three separate things decide what you can do: a
global role of **setter** (granted by an administrator — lets you create
problems and contests); being the **owner** of your school's organisation
(lets you import students, restrict contests to the school, and set member
roles); and being the **creator** of a contest (lets you edit it, answer
questions, post announcements, disqualify, and always see the unfrozen
scoreboard). Two things stay administrator-only whatever your role:
**creating an organisation** and **rejudging**.

### 1. Your school's organisation

**Orgs** (`/orgs`). Only an administrator sees the **New organization** form,
so ask one to create it with a **slug** (e.g. `thpt-abc`), a **name**, a
**joining** policy (*open* / *by request* / *invite only*) and a
**visibility**. **Whoever creates it becomes its owner** — join it, then have
an administrator or the current owner change your **Role** to *owner* in the
**Members** table. Only an owner or a global administrator may set roles, and
the last owner can never be demoted away.

The org page also carries the **Join requests** queue (**Approve** /
**Decline**), the member roster with role changes and **Remove**, and the
contests attached to the organisation.

### 2. Importing students

**Import students** appears on the org page for an **org owner or a global
administrator** only — an org *admin* is not enough.

One student per line: **username, full name, and an email if there is one**. A
header row is optional; **2000 rows maximum**. Paste into the box or pick a
CSV file. Press **Check list** first — a dry run that creates nothing and
reports every bad row by **Row**, **Field** and **Problem**, or shows a
preview and *Will create n accounts*. Then **Create accounts**.

Rules worth memorising: **one bad row means nothing is created**; the
generated **passwords are shown exactly once** (there is a **Print** button, a
**Download CSV** link and a copyable box — none of it is recoverable later);
every student **must set their own password at first sign-in**; a student with
**no email** gets an internal placeholder address and therefore **cannot use
"Forgot your password?"**; and a real import is limited to **one per
organisation per minute** (checking is unlimited). A large class takes a while
— one password hash per account — so do not close the tab. The same job can be
run on the server with `corepack pnpm org:import` (see `docs/runbook.md`).

### 3. Creating a contest

With **setter** or above, **Contests** shows **New contest**: a **key**, a
**name**, **starts** / **ends** (entered in your own time zone), a **format**
(`icpc`, `ioi16`, `legacy_ioi`, `default` — the judge's own vocabulary,
untranslated), **Freeze (minutes)** (whole minutes, shorter than the contest;
empty or `0` means no freeze), a **visibility** (who *sees* it) and
**Restrict to organizations** (who may *enter* it). The problem table takes a
**code**, **points** and **partial** flag per row; **Add problem** adds a row.

Editing afterwards is **Edit contest**. Once a contest has started you **may
not remove a problem** — the refusal is deliberate, removing one would take
its submissions with it — but adding problems and changing points still work,
and while the **start time is frozen, the end time is not**: extending the
round mid-contest is supported.

### 4. Restricting a contest to your school

With no organisation selected, anyone who can see the contest may enter it.
Select one or more and **only their members may join**; everyone else is
refused, and told which organisations the contest is for. You may only attach
organisations you **own or administer** — plain membership is not enough —
while organisations already attached stay listed and keep saving. Attached
names are **published on the contest page**, private organisations included, a
refusal nobody can read being worse. Removing a pupil from the org mid-contest
does **not** delete the participation they already hold; it only stops new
ones. Global administrators are exempt; the contest's own creator is not.

### 5. Invigilating: announcements and answers

In the **Q&A / Announcements** panel the creator and administrators get extra
controls. **Post** an announcement and every participant is notified.
**Answer** a question and the asker is notified. **Publish** it — with its
answer — when the whole room needs it, and everyone is notified.

Watch for: questions are private to asker and organisers by default; each
person may ask 20 per contest per hour; the feed shows the newest 200 and says
when it has cut; it refreshes every 30 seconds while the contest runs and
never after it ends; and — the important one — **the Q&A is not governed by
the freeze**. An answer that names a verdict leaks it straight through a frozen
scoreboard. That is invigilator discipline, not a mechanism.

### 6. The scoreboard freeze

While the freeze is on, competitors see **Scoreboard frozen since …** and
`?+n` in cells with unpublished attempts, and other people's verdicts inside
the window are hidden on the submission pages too (the submissions stay
listed, only the outcomes are withheld). Everyone always sees their own
results. **The creator and administrators always get the true, unfrozen
board** — that is the one to read at the prize-giving. Everything is revealed
as each participation's own window ends, so a virtual entrant stays masked
until theirs does. Separately, and regardless of freezing, a contest
submission's **source** is withheld from other competitors until the
submitter's window closes.

### 7. Disqualification and rejudging

On the **Scoreboard**, each row carries **Disqualify …** (and **Reinstate …**)
for the creator and administrators. A disqualified row stays on the board,
marked. Disqualification binds the **person**, so a later re-join inherits it.

**Rejudging is administrator-only** — there is no button for a setter. Report
a broken test or statement to an administrator, who can rejudge a single
submission from its page, or every submission of a problem from the bottom of
the problem edit screen. A rejudge never replays ratings by itself: it names
the contests that need re-rating, and that step is manual.

### 8. Exporting the scoreboard

There is **no export button**. Three ways that work: **print the scoreboard
page** (the print layout already drops the navigation — "Save as PDF" if you
want a file); **select and copy the table** into a spreadsheet, since it is a
real HTML table; or **call the API** — mint a read-scoped token at
`/account/tokens` and `GET /api/v1/contests/{key}/scoreboard` (the **API** link
in the nav has a try-it console). The same three work for the contest's
submission list.

### 9. Problems, and setting work

With **setter**, **Problems** offers **New problem**: code, name, statement
(Markdown with `$…$` maths), visibility and organisations, **source access**
(*private*, or *solved* — anyone holding an `AC`), **topics** and
**difficulty**, an **editorial** with a **publish** checkbox (withheld from
anyone sitting a contest on that problem unless they have solved it), and the
author/curator/tester **members** list. Time and memory limits and the tests
themselves come from the uploaded package on the **Revisions** screen: upload,
**attach**, then **publish**. Submissions are judged against the revision
published when they were sent, so publishing a new one never disturbs old
results.

There is no "homework" object. In practice work is set either as a
**long-running contest restricted to the school** (§3–4), which gives a
deadline, a scoreboard and statistics, or as a **filtered problem-list URL** —
pick topics and a difficulty range on **Problems** and send the address; the
filters live in the URL, and each pupil's **Me** column tracks their own
progress.

### 10. Problem PDFs

**Download problems (PDF)** on a contest page renders the whole contest as one
document: a cover with the window and per-problem limits, then each problem on
its own page, numbered and labelled `Bài A.`, `Bài B.`… **The language follows
the language you are viewing in**, so press **EN** first if you want English.
Single problems have their own **PDF** link. The contest link only appears once
there is a visible problem list — before the start that list is concealed and
the route answers "not found". A server without the PDF toolchain answers a
clear error instead; the statements are unaffected on the web. For bilingual
statements, separate the two halves with an `## English` (or `## Tiếng Việt`)
heading — that is the marker the renderer splits on.

### 11. Statistics

Each problem page ends with **Statistics** — submissions, people who tried,
people who solved, acceptance rate, and a **first solver** row with time and
memory — and the problem list gains a **Solved** column.

One thing to know before quoting these mid-round: **a submission is only
counted once its submitter's contest window has closed.** During a live
contest the figures, and the "first solver", do not describe the room in front
of you; they correct themselves at the bell. The numbers are identical for
every viewer, administrators included. To watch a live round, use the
**Scoreboard** (unfrozen for you) and the contest's **All submissions** list
instead.

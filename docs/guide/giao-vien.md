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
có**. Dòng tiêu đề là tuỳ chọn. Dán thẳng vào ô **Danh sách học sinh** hoặc
**Chọn tệp CSV** — danh sách dài bao nhiêu cũng được: **mỗi lượt gửi tối đa
500 dòng**, và trang web **tự cắt danh sách thành từng khúc 500 dòng**, gửi
lần lượt, có thanh tiến độ, rồi gộp tất cả mật khẩu vào một bảng.

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
  thì phải nhờ quản trị viên. Và nếu máy chủ **chưa khai `SMTP_HOST`** thì
  **không ai** đặt lại mật khẩu được, kể cả người có email thật: yêu cầu bị từ
  chối `503 mail_unavailable` (D155). Hỏi quản trị viên xem bảng **Thư điện
  tử** trên `/admin` ghi *SMTP* hay *chưa cấu hình* trước khi hứa với học sinh.
- **Một tên đăng nhập trùng nhau giữa hai khúc** bị chặn ngay trên trình
  duyệt, trước khi gửi đi — không lượt gửi nào một mình nhìn thấy được điều đó.
- Tối đa **mười lượt nhập mỗi tổ chức mỗi phút** (bấm *Kiểm tra danh sách* bao
  nhiêu lần cũng được) — đủ cho 5000 học sinh trong một phút.
- Với lớp rất đông, thao tác này chậm (mỗi tài khoản là một lần băm mật
  khẩu) — đừng đóng tab giữa chừng. Nếu một khúc lỗi giữa chừng, màn hình vẫn
  giữ nguyên mật khẩu của các khúc đã tạo xong, kèm lý do dừng.

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

## 8. Xuất kết quả và in giấy chứng nhận

**Kỳ thi kết thúc**, trang kỳ thi hiện thêm **ba** liên kết cho người tổ chức.
(Liên kết **Phiếu dự thi (PDF)** thì khác: nó hiện cho người tổ chức **mọi lúc**,
kể cả trước giờ thi — D129.)

- **Kết quả (CSV)** — bảng kết quả mở thẳng bằng Excel/LibreOffice: hạng, tên
  đăng nhập, họ tên, **tổ chức của chính thí sinh**, điểm/số lần nộp/thời gian
  từng bài, tổng điểm, điểm phạt, cột `disqualified` và cột `virtual` (`0` là
  thi thật, `n` là lần thi ảo thứ *n*). Tệp có BOM UTF-8 nên tiếng Việt không
  bị vỡ dấu khi mở bằng Excel. **Người bị hủy tư cách vẫn nằm trong tệp**, có
  đánh dấu — tệp phải tả đúng kỳ thi đã diễn ra.
- **Kết quả (PDF)** — vẫn bảng đó, dựng ngang khổ A4, đánh số trang, dòng bị
  hủy tư cách ghi `[DQ]`, dòng thi ảo ghi `(ảo)`.
- **Giấy chứng nhận (PDF)** — kèm ô số **Cấp tới hạng** (mặc định 3, nhận từ 1
  tới 1000); nút này dựng đúng đường dẫn `?top=N` bên dưới.

Hai đường dẫn dưới đây vẫn dùng được, và là cách duy nhất để cấp cho **một
người**; mở khi đang đăng nhập bằng tài khoản chạy kỳ thi:

```
/api/v1/contests/{key}/certificates.pdf?top=10
/api/v1/contests/{key}/certificates.pdf?username=an.nguyen
```

Mỗi tờ một trang A4 nằm ngang, ký tên là **các tổ chức của kỳ thi** (không có
thì ghi `DuckOJ`), đề ngày **kết thúc kỳ thi** — nên in hai lần vẫn ra đúng
một tờ giấy. Người bị hủy tư cách và các lượt thi ảo **không được cấp**, và
`top=10` đếm 10 người sau khi đã loại họ ra, không để lại chỗ trống.

Ba đường dẫn trên **chỉ người tạo kỳ thi và quản trị viên toàn hệ thống** mở
được, ở bất kỳ giờ nào — vì chúng dựng từ bảng điểm **chưa đóng băng**. Máy
chủ không cài bộ dựng PDF thì hai đường dẫn `.pdf` báo lỗi rõ ràng, còn `.csv`
vẫn chạy bình thường (nó không cần bộ dựng).

Ngoài ra vẫn có ba cách cũ, dùng được cả khi kỳ thi đang chạy: **in trang Bảng
điểm** (Ctrl/Cmd + P — bản in đã tự bỏ thanh điều hướng), **chọn và sao chép**
bảng vào bảng tính (bảng điểm là một `<table>` HTML thật), hoặc **gọi API**
`GET /api/v1/contests/{key}/scoreboard` bằng một **Mã truy cập**
(`/account/tokens`) có phạm vi đọc. Danh sách bài nộp của riêng kỳ thi (liên
kết **Tất cả bài nộp**) lấy được theo đúng ba cách đó.

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

**Giao bài về nhà.** Trang tổ chức của trường có mục **Bài tập về nhà**; **chủ
sở hữu *hoặc quản trị viên* của tổ chức** (và quản trị viên toàn hệ thống) thấy
thêm nút **Giao bài tập**. Chú ý là quy tắc này **khác** với mục 2: nhập danh
sách học sinh thì quản trị viên của tổ chức không đủ quyền, còn giao bài tập
thì đủ. Màn soạn có **Định danh**,
**Tên**, **Mô tả**, **Hạn nộp** (để trống là không có hạn) và **Danh sách
bài** — gõ mã hoặc tên vào ô tìm, bấm **Thêm**, sắp thứ tự bằng **Lên** /
**Xuống**, và đặt **Điểm cho** từng bài. Sửa lại bằng **Sửa bài tập**, gỡ bằng
**Thu hồi bài tập** (các bài toán không bị ảnh hưởng).

- Chỉ giao được bài **học sinh trường mình mở được** — bài công khai, hoặc bài
  chia sẻ cho đúng tổ chức này. Bài riêng tư, bài của trường khác, mã sai, mã
  lặp: hệ thống từ chối lưu và chỉ rõ dòng nào sai.
- **Hạn nộp tính cả đúng thời điểm đó.** Bài giải sau hạn vẫn được ghi, nằm ở
  cột **Nộp muộn** *bên cạnh* kết quả đúng hạn chứ không thay chỗ nó — một em
  nộp sai trước hạn rồi làm được sau hạn thì thầy cô thấy cả hai.
- **Bài tập chỉ hiện với thành viên tổ chức.** Người ngoài thấy danh sách
  trống và mọi đường dẫn bài tập trả về "không có" — cố ý như vậy, vì tên các
  bài trong đó có thể là bài chỉ chia sẻ riêng cho trường.
- **Kết quả cả lớp** là bảng cả lớp × cả danh sách bài (cuộn ngang được), có
  nút **Tải thêm** cho lớp đông; **Tải CSV** lấy **toàn bộ** danh sách, không
  chỉ trang đang xem. Bài nộp trong một kỳ thi **còn đang mở** chưa được tính
  vào bảng này (đúng như bảng điểm), nhưng trang của chính học sinh thì có —
  nên các em thấy điểm của mình trước thầy cô.

Hai cách cũ vẫn dùng được: **kỳ thi dài ngày** giới hạn cho tổ chức của trường
(mục 3 và 4) khi cần xếp hạng, và **đường dẫn danh sách bài đã lọc** (mở **Bài
tập**, chọn **Chủ đề** và **Độ khó**, sao chép địa chỉ trang) khi chỉ cần gợi
ý luyện tập.

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
giải được, tỉ lệ được chấp nhận, phân bố theo kết quả và theo ngôn ngữ, dòng
**Người giải đầu tiên** — chỉ **tên đăng nhập và thời điểm nộp**, không có thời
gian chạy hay bộ nhớ — và, tách riêng ngay bên dưới, một bảng **những lời giải
nhanh nhất** với các cột *Thí sinh / Thời gian / Bộ nhớ / Bài nộp*. Hai thứ đó
là hai thứ khác nhau. Danh sách **Bài tập** có thêm cột **Đã giải**.

Một điều phải biết khi đọc con số giữa kỳ thi: **một bài nộp chỉ được tính khi
lượt thi của người nộp đã kết thúc.** Vì vậy giữa giờ thi, thống kê và "người
giải đầu tiên" chưa phản ánh phòng thi đang chạy, và sẽ tự đúng lại khi hết
giờ. Quản trị viên thấy đúng những con số bạn thấy — nhưng **người đang dự một
kỳ thi có dùng bài này** (mà không phải người tạo kỳ thi ấy) thì được trả về
**thống kê trắng**, giống hệt một bài chưa ai đụng tới, không có dấu hiệu gì
báo là đã bị che (D35).

Muốn theo dõi phòng thi ngay lúc đang thi thì dùng màn **Theo dõi trực tiếp**
(mục 12), hoặc **Bảng điểm** (không đóng băng với bạn) và **Tất cả bài nộp** của
kỳ thi — chứ không phải mục Thống kê.

## 12. Theo dõi trực tiếp

Trang kỳ thi có nút **Theo dõi trực tiếp** (chỉ người tạo kỳ thi và quản trị
viên thấy) dẫn tới màn hình `/contests/{mã}/monitor` — bảng điều khiển phòng thi
đang chạy, **tự cập nhật mỗi 5 giây** và nhận thêm tín hiệu tức thời khi có bài
nộp mới.

- Các ô trên cùng: **Thí sinh đang kết nối**, **Đang chờ chấm**, **Chờ lâu
  nhất**, **Máy chấm hoạt động** (toàn hệ thống, không riêng kỳ thi), **Câu hỏi
  chưa trả lời** và **Lượt nộp bị từ chối (10 phút)**.
- Bảng **Các bài**: mỗi bài kèm **Lượt nộp**, **Được chấp nhận**, **Số người
  giải được**, **Đang chấm** và thanh **Tỉ lệ đạt**.
- **Bài nộp mới nhất** — năm mươi bài gần nhất, **kèm kết quả thật**: đóng băng
  bảng điểm không giấu gì với ban tổ chức ở màn này.
- **Câu hỏi đang chờ** — các câu chưa trả lời; bấm để sang trang kỳ thi trả lời.

Đây là màn để trực phòng thi lúc đang chạy. Khác với mục **Thống kê** (mục 11) —
vốn chỉ tính một bài nộp sau khi lượt thi của người nộp đã kết thúc — màn theo
dõi hiện đúng những gì đang diễn ra ngay lúc này.

## 13. Kiểm tra trùng lặp

Cuối trang một kỳ thi, người tạo kỳ thi và quản trị viên thấy mục **Kiểm tra
trùng lặp** — báo cáo mức giống nhau giữa các bài nộp, để soi gian lận. **Chỉ
ban tổ chức xem được**, và nó **không** tự huỷ tư cách, không báo cho ai, không
lọt ra màn hình thí sinh.

1. Đặt **Ngưỡng** rồi bấm **Chạy kiểm tra**. Trang tự cập nhật trong lúc chạy.
2. Xong, bảng liệt kê từng cặp thí sinh theo bài, kèm hai con số: **Phần chung**
   (một bài nằm gọn trong bài kia bao nhiêu — bắt được kiểu chèn thêm rác cho
   khác đi) và **Tổng thể**. Bấm **So sánh** để xem hai bài đặt cạnh nhau, phần
   trùng được tô sáng.

Điểm cao là **lý do để đọc lại hai bài làm**, không phải là kết luận: hai em
được dạy cùng một kỹ thuật vẫn có thể giống nhau mà trong sạch. Báo cáo chỉ so
các bài cùng một họ ngôn ngữ với nhau.

## 14. Thi đồng đội

DuckOJ chấm được kỳ thi **đồng đội** kiểu ICPC: một đội nộp chung và đứng chung
một dòng trên bảng điểm.

**Lập đội.** Trang tổ chức của trường có mục **Đội tuyển**; chủ sở hữu hoặc quản
trị viên của tổ chức thấy nút **Lập đội** với **Định danh**, **Tên đội** và
**Thành viên** (gõ tên tài khoản, cách nhau bởi dấu phẩy hoặc khoảng trắng — ai
được nêu cũng phải đã là thành viên của tổ chức này).

**Ra kỳ thi đồng đội.** Ở màn tạo/sửa kỳ thi, đặt chế độ **Thi đồng đội** và
**Số thành viên mỗi đội** (ba người là đội hình ICPC). Kỳ thi đồng đội **bắt
buộc giới hạn theo tổ chức** (mục 4) và **không tính rating**.

**Học sinh vào thi** bằng ô **Thi với đội** trên trang kỳ thi rồi chọn đội của
mình; sau đó trang ghi **Đang thi với đội …**. Người bấm tham gia giữ lượt thi
của cả đội — mỗi đội đúng một lượt, không có thi ảo.

Vài điều khi trực:

- **Danh sách thành viên bị khoá trong lúc đội đang thi**: sửa đội giữa kỳ thi
  bị từ chối, kèm dòng *Đội này đang thi, nên danh sách thành viên được giữ
  nguyên cho tới khi kỳ thi kết thúc.* Đổi tên đội thì vẫn được.
- Bảng điểm in **tên đội**; huỷ tư cách và giấy chứng nhận đi theo đội. **Chỉ
  `Kết quả (CSV)` có cột `members`** — bản PDF giữ nguyên bộ cột của nó (hạng,
  tên đăng nhập, họ tên, đơn vị, từng bài, tổng, điểm phạt) và **không in danh
  sách thành viên ở đâu cả**. Muốn có tờ giấy ghi tên từng em thì in **giấy
  chứng nhận** — mỗi tờ liệt kê thành viên của đội — chứ đừng trông vào bảng
  kết quả PDF.
- Báo cáo **Kiểm tra trùng lặp** gắn nhãn theo đội, nên hai người cùng một đội
  không bao giờ bị đem ra so với nhau.
- Xếp sẵn một đội vào kỳ thi bằng đường dẫn `POST
  /api/v1/contests/{mã}/participants` với thân `{ "teamSlug": "…" }`, mở khi
  đang đăng nhập bằng tài khoản chạy kỳ thi — tiện khi cần ghi danh cả đội trước
  giờ thi.

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
header row is optional. Paste into the box or pick a CSV file — the list may
be any length: **one request carries at most 500 rows**, and the panel
**splits a longer list into 500-row chunks itself**, sends them in order with
a progress bar, and merges every chunk's credentials into one table. Press
**Check the list** first — a dry run that creates nothing and reports every bad
row by **Row**, **Field** and **Problem**, or shows a preview and *Will create
n accounts*. Then **Create the accounts**.

Rules worth memorising: **one bad row means nothing is created**; a username
the FILE repeats across two chunks is refused in the browser before anything
is sent; the generated **passwords are shown exactly once** (there is a
**Print** button, a **Download CSV** link and a copyable box — none of it is
recoverable later); every student **must set their own password at first
sign-in**; a student with **no email** gets an internal placeholder address
and therefore **cannot use "Forgot your password?"** (and if the server has no
`SMTP_HOST`, *nobody* can — the request is refused `503 mail_unavailable`,
D155; check the **Mail** panel on `/admin` before promising a pupil a reset);
and imports are limited
to **ten per organisation per minute** (checking is unlimited), which is the
same 5,000 pupils a minute. A large class takes a while — one password hash
per account — so do not close the tab; if a chunk fails part-way the screen
keeps the credentials the earlier chunks created, beside the reason it
stopped. The same job can be run on the server with `corepack pnpm org:import`
(see `docs/runbook.md`).

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

On the **Scoreboard**, each row carries **DQ {name}** (and **un-DQ {name}**)
for the creator and administrators. A disqualified row stays on the board,
marked. Disqualification binds the **person**, so a later re-join inherits it.

**Rejudging is administrator-only** — there is no button for a setter. Report
a broken test or statement to an administrator, who can rejudge a single
submission from its page, or every submission of a problem from the bottom of
the problem edit screen. A rejudge never replays ratings by itself: it names
the contests that need re-rating, and that step is manual.

### 8. Exporting the results, and printing certificates

**Once the contest has finished**, its page offers the organisers **three**
links. (**Seat slips (PDF)** is different — organisers get that one at any
hour, including before the start, per D129.)
**Results (CSV)** — rank, username, display name, **the competitor's own
organisations**, points/attempts/time per problem, total, penalty, a
`disqualified` column and a `virtual` one (`0` live, `n` the n-th replay),
written with a UTF-8 BOM so Excel does not mangle Vietnamese — and **Results
(PDF)**, the same board typeset landscape, page-numbered, with `[DQ]` and
`(ảo)` on the rows that keep their place. **A disqualified row is exported and
flagged, never dropped**: the file has to describe the contest that happened.

**Certificates (PDF)** is the third button, with a **Down to rank** number box
(default 3, 1–1000) that builds the `?top=N` route below. The two routes still
work, and naming one person is only possible through them — call them while
signed in as the person who runs the contest:

```
/api/v1/contests/{key}/certificates.pdf?top=10
/api/v1/contests/{key}/certificates.pdf?username=an.nguyen
```

One landscape A4 sheet each, signed by the **contest's organisations** (or
`DuckOJ` when it has none) and dated by the contest's **end**, so printing it
twice gives the same sheet. Disqualified rows and virtual replays get none,
and `top=10` counts ten *after* that exclusion rather than leaving gaps.

All three are for the **contest's creator and global administrators only**, at
any hour, because each is folded from the **unfrozen** board. Without the PDF
toolchain the two `.pdf` routes say so plainly; the `.csv` needs none and
works regardless.

The older three ways still work, and work mid-contest: **print the scoreboard
page** (the print layout already drops the navigation), **select and copy the
table** into a spreadsheet, or **call the API** — a read-scoped token at
`/account/tokens` and `GET /api/v1/contests/{key}/scoreboard`. The same three
work for the contest's submission list.

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

**Setting homework.** Your school's organisation page carries **Problem
sets**, and an org **owner *or admin*** (and a global admin) gets **Assign a
problem set** — a different rule from §2, where an org admin is *not* enough to
import a roster: a slug, a name, a
description, a **Deadline** (empty for none) and the **Problems** list —
search by code or name, **Add**, order with **Move up** / **Move down**, and
give each its **Points**. **Edit this set** changes it; **Withdraw this set**
removes it without touching the problems.

Only problems your pupils can open may be assigned — public, or shared with
this organisation; anything else is refused by row. The **deadline is
inclusive**, and work solved after it lands in a separate **Late** column
*beside* the on-time result, never instead of it. Sets are **members only**:
an outsider sees an empty list and every set answers "not found", because the
problem codes in a set can themselves be school-only. **Class progress** is
the whole class × the whole set (scroll sideways, **Load more** for a big
class), and **Download CSV** takes the entire roster rather than the page on
screen. A submission inside a contest window that is still open does not count
towards the grid — as on the scoreboard — though it does on the pupil's own
page, so pupils see their score before their teacher does.

The two older ways still work: a **long-running contest restricted to the
school** (§3–4) when you want a ranking, and a **filtered problem-list URL**
when you only want practice.

### 10. Problem PDFs

**Problems (PDF)** on a contest page renders the whole contest as one
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
people who solved, acceptance rate, a verdict and a language breakdown, and a
**first solver** line carrying only a **username and the time they submitted**.
The table of run times and memory beside it is a separate, unlabelled one: the
**fastest accepted solutions**, columns *Competitor / Time / Memory /
Submission*. The problem list gains a **Solved** column.

One thing to know before quoting these mid-round: **a submission is only
counted once its submitter's contest window has closed.** During a live
contest the figures, and the "first solver", do not describe the room in front
of you; they correct themselves at the bell. Administrators see exactly what
you see — but a viewer who is **competing in a running contest that uses this
problem** (and did not create it) is handed **blank statistics**, identical in
shape to a problem nobody has attempted and flagged in no way at all (D35). To watch a live round, use the
**Live monitor** (§12), or the **Scoreboard** (unfrozen for you) and the
contest's **All submissions** list, instead.

### 12. The live monitor

A contest page carries a **Live monitor** button (creator and administrators
only) to `/contests/{key}/monitor` — a dashboard of the running room that
**refreshes every 5 seconds** and takes an instant nudge whenever a submission
lands.

- The tiles: **Competitors connected**, the queue depth and its oldest wait,
  **Judges up** (system-wide, not this contest), **Questions unanswered**
  and refusals in the last 10 minutes.
- A per-problem table with **Attempts**, **Accepted**, **Solvers**, **Judging**
  and a **Pass rate** bar.
- **Latest submissions** — the newest fifty, **with their true verdicts**: the
  scoreboard freeze hides nothing from the organisers here.
- **Questions waiting** — the panel, not to be confused with the tile of the
  same subject above — each a link to answer on the contest page.

This is the screen to invigilate from. Unlike **Statistics** (§11), which counts
a submission only after its submitter's window closes, the monitor shows exactly
what is happening right now.

### 13. The duplicate-source check

At the foot of a contest page, the creator and administrators see a
**Duplicate-source check** — a report of how alike the submissions are, for
spotting cheating. It is **visible to the organisers only**, and it disqualifies
nobody, notifies nobody, and never reaches a competitor's screen.

Set a **Threshold** and press **Run the check**; the page updates while it runs.
The table then lists each pair of competitors per problem with two numbers:
**Shared** (how far one program sits inside the other — the measure that catches
padding added to look different) and **Overall**. **Compare** shows the two
sources side by side with the matches highlighted.

A high score is a **reason to read the two programs**, never a verdict: two
pupils taught the same technique can look alike and be innocent. Only sources in
the same language family are compared.

### 14. Team contests

DuckOJ runs ICPC-style **team contests**: a team submits together and holds one
row on the scoreboard.

**Assembling a team.** Your school's organisation page carries **Teams**; an org
owner or administrator gets **Assemble a team** with a **Slug**, a **Name** and
**Members** (usernames separated by commas or spaces — everyone named must
already be a member of this organisation).

**Running one.** On the contest form set the mode to **Team contest** and
**Members per team** (three is the ICPC roster). A team contest **must be
restricted to organisations** (§4) and is **never rated**.

**Pupils enter** through the **Enter as** picker on the contest page, choosing
their team; the page then reads **Competing as …**. Whoever pressed Join holds
the whole team's participation — one per team, and no virtual replays.

While invigilating:

- **A team's roster is locked while it is competing**: a mid-contest edit is
  refused with *This team is competing right now, so its roster is fixed until
  the round ends.* Renaming still works.
- The scoreboard prints the **team name**; disqualification and certificates
  follow the team. **Only `Results (CSV)` gains a `members` column** — the PDF
  keeps its fixed set (rank, username, name, org, per problem, total, penalty)
  and prints no roster anywhere. For a sheet naming each pupil, print the
  **certificates**, which do list a team's members; do not expect it of the
  results PDF.
- The **duplicate-source check** labels by team, so two teammates are never
  compared with each other.
- Seed a team into a contest with `POST /api/v1/contests/{key}/participants` and
  a `{ "teamSlug": "…" }` body, signed in as the person who runs the contest —
  handy for enrolling a team before the start.

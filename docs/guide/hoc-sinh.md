# Hướng dẫn cho học sinh

Mọi thứ bạn cần để thi và luyện tập trên DuckOJ. Tên các nút, các ô và các
mục trong hướng dẫn này đúng như trên màn hình tiếng Việt; nếu bạn đang bật
tiếng Anh thì bấm **VI** ở thanh trên cùng.

Trên **máy tính**, thanh điều hướng ở trên cùng chia làm ba cụm: phần chính
(**Bài tập**, **Kỳ thi**, **Bài nộp**, **Tổ chức**), phần tra cứu (**Trợ
giúp**, **API**, và **Quản trị** nếu bạn là quản trị viên), rồi phần tài
khoản ở bên phải — chuông thông báo, tên bạn, **Tiến độ**, **Cài đặt**,
**Bảo mật**, **Mã truy cập**, **Mật khẩu**, nút **VI | EN** và **Đăng xuất**.

Trên **điện thoại**, thanh nằm ở **đáy màn hình** và chỉ có năm thẻ: **Bài
tập**, **Kỳ thi**, **Bài nộp**, **Thông báo** (chưa đăng nhập thì thẻ này là
**Đăng nhập**) và **Thêm**. Bấm **Thêm** mở một bảng chứa mọi mục còn lại —
**Tổ chức**, trang cá nhân, **Tiến độ**, **Cài đặt**, **Bảo mật**, **Mã truy
cập**, **Mật khẩu**, **Trợ giúp**, **API**, **VI | EN**, **Đăng xuất**. Đóng bảng bằng
phím `Esc`, bằng nút **Đóng**, hoặc bấm ra ngoài bảng.

## 1. Đăng ký

> **Nhiều trường không mở đăng ký.** Từ D200, quản trị viên chọn ai được tạo
> tài khoản, và **mặc định là không ai** — tài khoản do nhà trường lập. Nếu
> vào `/register` mà trang báo *"Trang này không nhận đăng ký"* thì đó là
> đúng thiết kế, không phải lỗi: hãy hỏi thầy cô để được cấp tài khoản, hoặc
> dùng **Quên mật khẩu?** nếu bạn đã có tài khoản mà không vào được. Phần
> dưới đây áp dụng cho những nơi có mở đăng ký.

Vào **Đăng ký** (`/register`) và điền:

- **Tên đăng nhập** — từ 3 đến 32 ký tự, chỉ gồm chữ cái, chữ số, dấu chấm,
  gạch dưới và gạch nối. Tên đăng nhập là vĩnh viễn, không đổi được.
- **Email** — địa chỉ thật của bạn.
- **Tên hiển thị** — từ 1 đến 64 ký tự.
- **Mật khẩu** — ít nhất 10 ký tự, và **Nhập lại** cho khớp.

Đăng ký xong là bạn đã đăng nhập ngay, không phải chờ email. Một liên kết xác
nhận địa chỉ sẽ được gửi tới hộp thư; bấm vào đó khi rảnh.

Nếu địa chỉ email bạn nhập đã có tài khoản thì **không có tài khoản mới nào
được tạo**, và bước đăng nhập ngay sau đó sẽ không thành công. Khi gặp trường
hợp này, dùng **Quên mật khẩu?** với chính địa chỉ đó.

Số lần đăng ký từ một đường truyền có giới hạn. Nếu bị chặn, chờ ít phút rồi
thử lại.

> **Tài khoản do trường lập sẵn?** Đừng đăng ký. Giáo viên sẽ đưa bạn tên đăng
> nhập và mật khẩu — xem mục 10.

## 2. Đăng nhập

Trang chủ (`/`) có sẵn ô đăng nhập: **Tên đăng nhập hoặc email** và **Mật
khẩu**. Nếu tài khoản đã bật xác thực hai lớp, sẽ có thêm ô **Mã xác thực hai
lớp**.

Quên mật khẩu: bấm **Quên mật khẩu?** → nhập email → hệ thống gửi liên kết
đặt lại. **Liên kết hết hạn sau một giờ và chỉ dùng được một lần**; đổi mật
khẩu xong thì mọi phiên đăng nhập khác đều bị kết thúc.

Đăng nhập sai nhiều lần liên tiếp sẽ bị chặn tạm thời (tính theo cả tên đăng
nhập lẫn đường truyền). Chờ vài phút rồi thử lại, đừng bấm dồn.

Máy tính dùng chung: nhớ bấm **Đăng xuất**.

## 3. Xác thực hai lớp và mã khôi phục

Vào **Bảo mật** (`/account/security`). Trang này chỉ mở khi bạn đăng nhập
bằng phiên thường, không phải bằng mã truy cập API.

1. Bấm **Bật**.
2. Quét mã QR bằng ứng dụng xác thực (Google Authenticator, Aegis, …) hoặc
   nhập tay **chuỗi bí mật** hiện bên dưới.
3. Nhập **mã sáu chữ số** rồi bấm **Xác nhận**. Chưa xác nhận thì tài khoản
   vẫn đăng nhập bằng mật khẩu như cũ.

Ngay sau khi xác nhận, hệ thống hiện **tám mã khôi phục**. Đây là **lần duy
nhất** chúng xuất hiện:

- Bấm **Sao chép**, hoặc in trang ra, và cất ở chỗ **khác** với chiếc điện
  thoại đang cài ứng dụng xác thực.
- Mỗi mã dùng được **một lần**, thay cho mã từ ứng dụng.
- Trang **Bảo mật** luôn cho biết còn bao nhiêu mã chưa dùng.

Khi mất điện thoại: ở ô đăng nhập bấm **Dùng mã khôi phục** rồi nhập một mã
đã lưu. Muốn quay lại nhập mã từ ứng dụng thì bấm **Dùng mã từ ứng dụng**.

Hết mã hoặc sắp hết: bấm **Tạo bộ mã khôi phục mới** — cần một mã còn hiệu
lực từ ứng dụng để chứng minh đó là bạn, và bộ mới thay thế toàn bộ mã cũ.

Mất cả ứng dụng lẫn mã khôi phục: chỉ còn cách nhờ **quản trị viên** tắt xác
thực hai lớp cho tài khoản của bạn. Bạn sẽ nhận được một thông báo khi điều
đó xảy ra — nếu bạn không hề yêu cầu, hãy báo ngay cho ban tổ chức.

Tắt xác thực hai lớp cũng xoá luôn toàn bộ mã khôi phục.

## 4. Nộp bài

1. Mở **Bài tập** → chọn một bài. Trang bài có đề, giới hạn thời gian và bộ
   nhớ, và liên kết **PDF** nếu máy chủ dựng được bản in.
2. Bấm **Nộp bài giải**.
3. Chọn **Ngôn ngữ**, viết hoặc dán bài vào **Mã nguồn**, bấm **Nộp bài**.

Ô **Mã nguồn** là một trình soạn thảo thật: có số dòng, tô màu cú pháp, tự thụt
lề, và bấm `Tab` để thụt thêm. Dòng nhắc ngay dưới ô ghi **Ctrl/Cmd + Enter để
nộp · Tab để thụt lề**. Bấm **Mở tệp** để nạp bài từ một tệp trên máy; hai nút
bên cạnh phóng to và thu nhỏ cỡ chữ cho vừa mắt. Ô đếm ký tự cho biết bạn còn
cách giới hạn bao xa — vượt giới hạn thì nút nộp bị khoá.

DuckOJ **tự lưu bản nháp** ngay trong trình duyệt này, theo từng cặp (bài, ngôn
ngữ). Lỡ đóng tab hay tải lại trang, mở lại đúng bài đó là thấy dòng
**Khôi phục bản nháp bạn để lại ở đây** cùng bài cũ hiện lại. Bản nháp chỉ bị
xoá khi bài được **nhận** — nộp bị từ chối thì bài vẫn còn nguyên. Đổi ngôn ngữ
**không** xoá bài đang viết dở. Bản nháp nằm trong trình duyệt này thôi, nên mở
máy khác sẽ không thấy.

Bài nộp được chấm theo **phiên bản đề đang công bố lúc bạn gửi**, bằng bộ test
của người ra đề, trong môi trường cách ly.

Trang sẽ tự cập nhật trạng thái: *Đang xếp hàng* → *Đang biên dịch* → *Đang
chấm* → *Xong*. Nếu hiện dòng "Không nhận được cập nhật trực tiếp", chỉ cần
tải lại trang — bài nộp vẫn đang được chấm bình thường.

Kết quả là một mã ngắn, giữ nguyên trong mọi ngôn ngữ:

| Mã | Nghĩa |
| --- | --- |
| `AC` | Chấp nhận |
| `WA` | Sai kết quả |
| `TLE` | Quá thời gian |
| `MLE` | Quá bộ nhớ |
| `OLE` | Quá dữ liệu ra |
| `RTE` | Lỗi thực thi |
| `IR` | Mã trả về không hợp lệ |
| `CE` | Lỗi biên dịch |
| `IE` | Lỗi hệ thống |

`CE` kèm **Kết xuất trình biên dịch** — đọc dòng đầu tiên trước. `IE` là lỗi
của hệ thống, không phải của bạn: báo cho ban tổ chức.

## 5. Xem kết quả

**Bài nộp** (`/submissions`) liệt kê các bài đã nộp, lọc được theo **mã bài**,
**tên đăng nhập**, **mã kỳ thi** và **kết quả**. Bấm vào số hiệu để xem chi
tiết một bài nộp: kết quả từng test, thời gian, bộ nhớ và mã nguồn.

Hai trường hợp mã nguồn bị ẩn:

- **Trong lúc kỳ thi còn diễn ra**, mã nguồn của người khác bị ẩn cho tới khi
  lượt thi của họ kết thúc. Mã nguồn của **chính bạn** thì bạn luôn xem được.
- Với bài luyện tập, người ra đề có thể đặt quyền xem mã nguồn là *riêng tư*
  hoặc *đã giải* (ai đã có `AC` trên bài đó thì xem được).

## 6. Kỳ thi

**Kỳ thi** (`/contests`) liệt kê mọi kỳ thi bạn được thấy, kèm **Thể thức**,
**Bắt đầu**, **Kết thúc**, **Trạng thái** (*sắp diễn ra* / *đang diễn ra* /
*đã kết thúc*) và cột **Dành cho** nếu kỳ thi giới hạn theo tổ chức.

Trên trang một kỳ thi:

- Kỳ thi *sắp diễn ra*: nút bị khoá, bên cạnh ghi *Chưa bắt đầu*.
- Kỳ thi *đang diễn ra*: nút ghi **Tham gia** — dự thi chính thức. Nếu kỳ thi
  ghi *Chỉ dành cho thành viên của …* mà bạn không thuộc tổ chức đó thì nút
  này báo lỗi; nhờ giáo viên thêm bạn vào tổ chức trước.
- Kỳ thi *đã kết thúc*: nút ghi **Thi ảo** — thi lại một mình theo đúng độ
  dài kỳ thi, tính từ lúc bạn bấm. Không ảnh hưởng tới bảng điểm chính thức.
- Tham gia rồi, trang ghi *Đang thi chính thức* hoặc *Lần thi ảo n*, kèm
  **Thời gian của bạn kết thúc lúc …** — mốc phải nhớ.
- Bảng bài tập có nhãn `A`, `B`, `C`… và **Điểm**. Mỗi dòng có liên kết **Nộp
  bài**; chưa tham gia thì chỉ hiện *Tham gia để nộp bài*.
- **Bảng điểm**, **Tải đề (PDF)** (một tệp gồm toàn bộ đề, theo ngôn ngữ bạn
  đang xem), **Tất cả bài nộp** và **Bài nộp của tôi** của riêng kỳ thi này.

Nộp bài trong kỳ thi thì trang nộp ghi rõ **Nộp vào kỳ thi**; ngoài kỳ thi thì
ghi *Bài nộp luyện tập — không tính vào kỳ thi nào*. Hãy nhìn dòng đó trước
khi bấm nộp.

## 7. Hỏi đáp và thông báo

Ngay dưới bảng bài tập là mục **Hỏi đáp / Thông báo**.

- **Thông báo** do ban tổ chức đăng, ai cũng thấy.
- **Câu hỏi**: bạn phải **tham gia kỳ thi** mới hỏi được. Chọn bài cần hỏi
  (hoặc *Toàn kỳ thi*), viết câu hỏi, bấm **Gửi**.
- Câu hỏi của bạn mặc định là riêng — có ghi *(chỉ bạn và ban tổ chức thấy)*.
  Ban tổ chức có thể **Công bố** câu hỏi kèm câu trả lời cho cả phòng thi.
- Chưa được trả lời thì hiện *Đang chờ trả lời*.
- Có giới hạn **20 câu hỏi mỗi kỳ thi mỗi giờ** cho mỗi người.
- Mục này chỉ hiện **200 mục mới nhất**; khi có cắt bớt, hệ thống nói rõ.

Khi câu hỏi của bạn được trả lời, khi một câu hỏi được công bố, hay khi có
thông báo mới, chuông trên thanh điều hướng sẽ hiện số chưa đọc — trên điện
thoại chuông chính là thẻ **Thông báo** ở đáy màn hình. Trang
**Thông báo** có nút **Đánh dấu đã đọc tất cả**.

## 8. Bảng điểm và lúc bảng điểm đóng băng

**Bảng điểm** xếp theo **Điểm** rồi **Thời gian**. Thể thức ICPC hiển thị
`+`, `−` và số phút; các thể thức khác hiển thị điểm kèm mốc thời gian ghi
điểm. Dòng thi ảo ghi *(thi ảo)*, dòng bị huỷ tư cách ghi *(hủy tư cách)*.

Nhiều kỳ thi **đóng băng** bảng điểm trong ít phút cuối. Khi đó:

- Đầu bảng hiện **Bảng điểm đang đóng băng từ …**.
- Các bài nộp sau mốc đóng băng không được cộng vào bảng; ô của bài đó hiện
  `?+n` — nghĩa là *n* lượt nộp chưa được công bố kết quả.
- Cùng lúc đó, ở trang bài nộp, **kết quả bài nộp của người khác** trong
  khoảng đóng băng bị ẩn, kèm dòng *Được ẩn cho tới khi bảng điểm hết đóng
  băng*. Bài nộp vẫn hiện trong danh sách — chỉ kết quả bị giấu.
- **Bài nộp của chính bạn không bao giờ bị che với bạn.** Bạn luôn biết mình
  được bao nhiêu.
- Hết giờ thi của bạn thì mọi thứ hiện ra đầy đủ.

## 9. Bài tập về nhà và luyện tập

Trang tổ chức của trường bạn (**Tổ chức** → tên trường) có mục **Bài tập về
nhà**. Mỗi dòng là một bài tập thầy cô giao, kèm **Hạn nộp** (hoặc *không có
hạn*) và cột **Đã làm** cho biết bạn đã giải mấy bài trên tổng số.

Mở một bài tập ra là danh sách bài toán kèm **Điểm**, cột **Kết quả của bạn**
và liên kết **Nộp bài** đi thẳng sang màn nộp. Nếu bài tập có hạn nộp thì có
thêm cột **Nộp muộn** riêng: bài giải sau hạn vẫn được ghi nhận, **ghi bên
cạnh** kết quả đúng hạn chứ không thay chỗ nó — thầy cô thấy cả hai. Hạn nộp
tính **cả** đúng thời điểm ghi trên đó: nộp đúng phút chót vẫn là đúng hạn.

Mục này **chỉ hiện với thành viên của tổ chức**. Chưa được nhận vào trường thì
danh sách trống và mọi đường dẫn bài tập trả về "không có" — hãy nhờ thầy cô
thêm bạn vào, đừng đoán đường dẫn.

Ngoài ra thầy cô vẫn có thể giao bài bằng:

- **Một kỳ thi có thời gian dài** (vài ngày, giới hạn cho tổ chức của trường)
  — làm theo mục 6.
- **Một danh sách bài trong trang Bài tập** — mở **Bài tập**, lọc theo **Chủ
  đề** và **Độ khó** (1–10). Cột **Tôi** cho biết kết quả tốt nhất của bạn
  trên từng bài, cột **Đã giải** cho biết bao nhiêu người đã giải được. Bộ lọc
  nằm trong địa chỉ trang, nên bạn có thể gửi nguyên đường dẫn cho bạn bè.

Mục **Thống kê** ở cuối trang một bài cho biết tổng lượt nộp, số người thử, số
người giải được, tỉ lệ được chấp nhận và **người giải đầu tiên**.

> Trong lúc bạn đang dự một kỳ thi dùng bài đó, **Chủ đề** và **Độ khó** của
> bài bị giấu đi — để gợi ý về thuật toán không rò rỉ giữa giờ thi.

## 10. Lời giải

Bài nào có lời giải thì trang bài hiện mục **Lời giải** ở dạng đóng sẵn; phải
bấm vào mới mở ra, để bạn không vô tình đọc phải khi đang cuộn trang.

Lời giải bị giấu nếu bạn **đang dự một kỳ thi có dùng bài đó**, trừ khi bạn đã
có `AC` trên bài. Hết giờ thi thì ai cũng xem được.

## 11. Đổi mật khẩu lần đầu

Tài khoản do trường lập sẵn giữ một mật khẩu bạn không tự chọn. Lần đầu đăng
nhập, DuckOJ chặn mọi trang khác và hiện màn hình **Đổi mật khẩu** với dòng:
*Tài khoản này do trường lập cho bạn, với mật khẩu bạn không tự chọn. Hãy đặt
mật khẩu của riêng bạn trước khi tiếp tục.*

Nhập **Mật khẩu mới** (ít nhất 10 ký tự) hai lần rồi bấm **Đổi mật khẩu**.
Xong là dùng được toàn bộ trang. Mọi thiết bị khác đang đăng nhập đều bị đăng
xuất.

Sau này muốn đổi mật khẩu, vào **Mật khẩu** (`/account/password`) — lúc đó
phải nhập cả **Mật khẩu hiện tại**.

## 12. Tiến độ

**Tiến độ** (`/me/progress`) là bảng theo dõi việc luyện tập của riêng bạn —
trên máy tính nó nằm ở cụm tài khoản bên phải, trên điện thoại thì trong bảng
**Thêm**.

- Các ô đầu trang: **Số bài đã giải**, **Số bài đã thử**, **Chuỗi hiện tại**,
  **Chuỗi dài nhất** (tính trong mười hai tháng gần nhất) và **Rating**.
- **Hoạt động** — lịch nhiệt 365 ngày, mỗi ô một ngày, càng nhiều bài nộp thì
  ô càng đậm. Ngày tính theo **múi giờ trong Cài đặt** của bạn.
- **Theo chủ đề** và **Theo độ khó** — số bài đã giải trên số bài đã thử, đếm
  **theo bài** chứ không theo lượt nộp. Khi còn trống, trang ghi rõ rằng *một
  bài chỉ vào bảng này sau khi kỳ thi của nó khép lại*, nên giữa một kỳ thi
  đang chạy, các thanh này chưa cộng bài bạn vừa giải trong đó.
- **Kỳ thi đang diễn ra**, **Bài tập về nhà** (kèm hạn và số bài đã xong) và
  **Kết quả gần đây** (mười bài nộp mới nhất).

Trang **hồ sơ** công khai của bạn (bấm vào tên mình) chỉ hiện lịch nhiệt và hai
bảng chủ đề / độ khó — chuỗi, kỳ thi đang dự và bài tập về nhà là của riêng bạn,
người khác không thấy.

## 13. Cài đặt và những chỗ còn lại

- **Cài đặt** (`/account/settings`) — **Tên hiển thị**, **Ngôn ngữ** và **Múi
  giờ**. Ngôn ngữ chọn ở đây đi theo tài khoản trên mọi thiết bị và cũng là
  ngôn ngữ của email hệ thống gửi cho bạn. Chọn *Theo trình duyệt* để trả về
  mặc định.
- **VI | EN** trên thanh điều hướng (trên điện thoại: trong bảng **Thêm**)
  chỉ đổi ngôn ngữ cho trình duyệt này.
- Trang **hồ sơ** của bạn (bấm vào tên mình) có số bài đã giải, điểm, số bài
  nộp, **Rating** và lịch sử rating theo từng kỳ thi.
- **Tổ chức** (`/orgs`) — các trường/câu lạc bộ. Tuỳ cách gia nhập, bạn có thể
  **Gia nhập** ngay, **Xin gia nhập** và chờ duyệt, hoặc phải được mời.
- **Mã truy cập** (`/account/tokens`) — chỉ cần khi bạn muốn nộp bài bằng công
  cụ dòng lệnh. Mã hiện đúng một lần, sao chép ngay.

Gặp lỗi lạ, hoặc kết quả `IE`: báo cho giáo viên hoặc ban tổ chức, kèm **số
hiệu bài nộp**.

## English

Everything you need to compete and practise on DuckOJ. Button and field names
below are the English ones — press **EN** in the nav to match them.

On a **computer** the top bar is three clusters: the main sections
(**Problems**, **Contests**, **Submissions**, **Orgs**), then reference
(**Help**, **API**, and **Admin** if you are one), then your account on the
right — the bell, your name, **Progress**, **Settings**, **Security**,
**Tokens**, **Password**, the **VI | EN** toggle and **Sign out**.

On a **phone** the bar sits at the bottom of the screen and carries five tabs
only: **Problems**, **Contests**, **Submissions**, **Notifications** (or
**Sign in** when you are signed out) and **More**. **More** opens a sheet with
everything else — **Orgs**, your profile, **Progress**, **Settings**,
**Security**, **Tokens**, **Password**, **Help**, **API**, **VI | EN** and
**Sign out**.
Close it with `Esc`, with **Close**, or by tapping outside it.

### 1. Registering

Go to **Register** (`/register`): a **username** (3–32 characters; letters,
digits, dot, underscore, hyphen — permanent, it cannot be changed later), an
**email**, a **display name** (1–64 characters) and a **password** of at least
10 characters, typed twice.

You are signed in the moment you register; a verification link is emailed and
nothing here waits for it. If that email address already has an account, **no
new account is created** and the sign-in that follows will fail — use **Forgot
your password?** with that address instead. Registrations from one connection
are rate limited; wait a few minutes if you are refused.

If your school created your account for you, do not register — see §11.

### 2. Signing in

The home page carries the sign-in form: **Username or email** and
**Password**, plus a **Two-factor code** box if you have two-factor turned on.
**Forgot your password?** mails a reset link that expires in one hour, works
once, and signs every other session out. Repeated failures are rate limited by
username and by connection. On a shared machine, use **Sign out**.

### 3. Two-factor authentication and recovery codes

**Security** (`/account/security`), reachable only from a real session — not
from an API token. Press **Enable**, scan the QR code (or type the secret) in
an authenticator app, enter the six-digit code and press **Confirm**. Nothing
changes until that code is accepted.

You are then shown **eight recovery codes, once and only once**. Copy or print
them and keep them somewhere other than the phone holding the authenticator.
Each one signs you in a single time, in place of the app's code; the Security
page always shows how many are left.

Lost your phone? On the sign-in form press **Use a recovery code**. Running
low? **Generate new recovery codes** — it needs a live code from the app and
replaces the whole set. Lost both the app and the codes? Only an administrator
can turn two-factor off for you; you will get a notification when they do, and
if you did not ask for it, tell the organisers. Disabling two-factor also
destroys the recovery codes.

### 4. Submitting

Open **Problems**, pick one, press **Submit a solution**, choose a
**Language**, write or paste your **Source code** and press **Submit**. Your
submission is judged against the statement revision published at the moment you
sent it, with the setter's own tests, in a sandbox.

The **Source code** box is a real editor — line numbers, syntax colours,
auto-indent, `Tab` to indent — and the hint under it reads **Ctrl/Cmd + Enter
submits · Tab indents**. **Open a file** loads a solution from disk, and the two
buttons beside it grow or shrink the font. A counter shows how far you are from
the size limit; past it the submit button is disabled.

DuckOJ **saves a draft** in this browser as you type, keyed per (problem,
language). Close the tab or reload, reopen that problem, and it offers to
restore the draft you left — **Restored the draft you left here.** The draft is
cleared only once a submission is **accepted** (a refused one keeps it), and
switching language does **not** wipe what you are writing. It lives in this
browser alone, so another machine will not see it.

The page follows the job live — *Queued* → *Compiling* → *Grading* → *Done*.
If it says live updates are unavailable, just reload; grading is unaffected.

Verdicts are short codes, the same in every language: `AC` accepted, `WA`
wrong answer, `TLE` time limit, `MLE` memory limit, `OLE` output limit, `RTE`
runtime error, `IR` invalid return, `CE` compile error, `IE` internal error.
`CE` comes with the compiler output; `IE` is our fault, not yours — report it.

### 5. Reading results

**Submissions** (`/submissions`) filters by problem code, username, contest
key and verdict; click an id for per-test detail and the source. Someone
else's source is withheld while their contest window is still open, and a
setter may restrict a problem's sources to solvers only. Your own source is
always yours to read.

### 6. Contests

**Contests** (`/contests`) lists format, start, end, phase and, where the
contest is restricted, the organisations it is **For**. On a contest page one
button carries the whole entry: disabled and marked *Not started* before the
start, **Join** while the contest runs, and **Join virtually** once it has
finished — a virtual run replays the contest alone, on your own clock, without
touching the official scoreboard. Once you are in, the page says *Competing
live* or *Virtual attempt n* and **Your window closes at …**, which is the
deadline to watch. The problem table is labelled `A`, `B`, `C` with
their points and a **Submit** link each — non-participants only see *Join to
submit*. Below it: **Scoreboard**, **Download problems (PDF)** in the language
you are reading, **All submissions** and **My submissions** for this contest.

The submit page says either **Submitting into contest** or *Practice
submission — counts towards no contest*. Read that line before you press.

### 7. Q&A and announcements

The **Q&A / Announcements** panel sits under the problem table. Announcements
come from the organisers and everyone sees them. To ask, you must have joined:
pick the problem (or *Whole contest*), write, **Send**. Your question stays
private — *(only you and the organisers)* — until an organiser publishes it
with its answer. Unanswered ones say so. Each person may ask 20 questions per
contest per hour, and the panel shows the newest 200 entries, saying so when
it has cut older ones. The bell in the nav counts what is new.

### 8. The scoreboard, and the freeze

Ranking is by score, then time; ICPC contests use `+`, `−` and minutes.
Virtual and disqualified rows are marked as such.

Many contests **freeze** for the last few minutes. The board then says
**Scoreboard frozen since …**, submissions made after that instant are left
out of the ranking and their cells read `?+n` — *n* results not yet public. At
the same time other people's verdicts inside the freeze are hidden on the
submission pages, marked *Hidden until the scoreboard unfreezes*: the
submission is still listed, only its outcome is withheld. **Your own results
are never hidden from you**, and everything is revealed once your own window
ends.

### 9. Homework and practice

Your school's organisation page (**Orgs** → your school) carries
**Problem sets** — the homework your teachers assign. Each row is one set with
its **Due** date (or *no deadline*) and a **Done** column counting the
problems you have solved. Opening a set lists its problems with their
**Points**, your own **Your best** verdict and a **Submit** link; a set with a
deadline also gets a separate **Late** column, because work solved after the
deadline is recorded **beside** the on-time result rather than instead of it.
The deadline is inclusive — a submission at the stroke of it is on time. The
section is **members only**: until your school adds you, the list is empty and
every set address answers "not found".

Teachers may also set work as a long-running contest restricted to the school
(§6), or as a list of problems to solve. For the latter, use **Problems** with
the **Topics** and **Difficulty** (1–10) filters — the **Me** column is your
best verdict per problem, **Solved** is how many people have solved it, and
the filters live in the URL so you can share the exact list. Each problem
page ends with **Statistics**: submissions, people who tried, people who
solved, acceptance rate and the first solver. While you are sitting a contest
that uses a problem, its topics and difficulty are blanked, so hints cannot
leak mid-round.

### 10. Editorials

Where one exists, the problem page shows a collapsed **Editorial** section —
you have to open it yourself, so nobody meets a spoiler by scrolling.
It stays withheld while you are sitting a contest that uses the problem,
unless you have already solved it; once the contest window closes it is open
to everyone.

### 11. Your first password change

An account created for you by your school holds a password you did not choose.
On first sign-in DuckOJ shows nothing but the **Change password** screen until
you set your own: type a new password (10 characters or more) twice and press
**Change password**. Every other device is signed out. Later changes go
through **Password** (`/account/password`) and ask for your current password.

### 12. Progress

**Progress** (`/me/progress`) is your own practice dashboard — in the account
cluster on a computer, inside the **More** sheet on a phone.

- The tiles across the top: **Problems solved**, **Problems attempted**,
  **Current streak**, **Longest streak** (within the last twelve months) and
  **Rating**.
- **Activity** — a 365-day heatmap, one cell per day, darker for more
  submissions, counted in the time zone from your **Settings**.
- **By topic** and **By difficulty** — solved over attempted, counted **per
  problem**, not per submission. While they are empty the page says so, and that
  *a problem joins these bars once its contest window has closed* — so
  mid-contest they do not yet count what you just solved in it.
- **Contests under way**, **Homework due** (with deadlines and how many you have
  done) and **Recent verdicts** (your last ten submissions).

Your public **profile** (click your own name) shows only the heatmap and the two
topic/difficulty tables — the streak, your live contests and your homework are
yours alone.

### 13. Settings, and the rest

**Settings** (`/account/settings`) holds your display name, **Language** and
**Time zone**; a language chosen there follows your account onto every device
and is the language of the mail DuckOJ sends you. The **VI | EN** toggle in
the nav changes this browser only. Your profile (click your own name) shows
problems solved, points, submissions, **Rating** and the per-contest rating
history. **Orgs** (`/orgs`) lists schools and clubs — depending on the joining
policy you can join outright, request to join, or must be invited. **Tokens**
(`/account/tokens`) is only needed for command-line tools; a new token is
shown exactly once.

Anything strange, or an `IE` verdict: tell your teacher or the organisers, and
quote the **submission id**.

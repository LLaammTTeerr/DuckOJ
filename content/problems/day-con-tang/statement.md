# Dãy con tăng dài nhất

Trong buổi tổng kết, ban tổ chức xếp $N$ tấm ảnh thành một hàng ngang, tấm thứ
$i$ được chấm $a_i$ điểm. Người dẫn chương trình muốn chọn ra một số tấm ảnh —
giữ nguyên thứ tự từ trái sang phải — sao cho điểm của chúng **tăng thực sự**,
và muốn chọn được càng nhiều tấm càng tốt.

Một **dãy con** thu được bằng cách xoá đi một số phần tử (có thể không xoá phần
tử nào) mà không đổi thứ tự các phần tử còn lại. Dãy con $a_{i_1}, a_{i_2},
\ldots, a_{i_k}$ với $i_1 < i_2 < \cdots < i_k$ được gọi là **tăng thực sự** nếu
$a_{i_1} < a_{i_2} < \cdots < a_{i_k}$.

Hãy tìm độ dài lớn nhất của một dãy con tăng thực sự.

## Dữ liệu vào

- Dòng đầu chứa số nguyên $N$ $(1 \le N \le 10^5)$.
- Dòng thứ hai chứa $N$ số nguyên $a_1, a_2, \ldots, a_N$ $(1 \le a_i \le 10^9)$.

## Kết quả

In ra một số nguyên duy nhất là độ dài của dãy con tăng thực sự dài nhất.

## Ví dụ

| Dữ liệu vào | Kết quả | Giải thích |
| --- | --- | --- |
| `6`<br>`1 3 2 5 4 6` | `4` | Chẳng hạn $1, 3, 5, 6$ hoặc $1, 2, 4, 6$. |
| `5`<br>`5 4 3 2 1` | `1` | Dãy giảm, chỉ chọn được đúng một phần tử. |

## Giới hạn

- Thời gian: 2 giây. Bộ nhớ: 256 MiB.
- Nhóm `nho` (40 điểm): $N \le 1000$ — thuật toán quy hoạch động $O(N^2)$ là đủ.
- Nhóm `lon` (60 điểm): $N \le 10^5$ — cần lời giải $O(N \log N)$.

Lưu ý: các phần tử bằng nhau **không** kéo dài được dãy con, vì yêu cầu là tăng
thực sự chứ không phải không giảm.

---

## English

$N$ photographs are laid out in a row; the $i$-th scored $a_i$ points. The host
wants to pick as many of them as possible, keeping their left-to-right order,
so that the scores read **strictly increasing**.

A **subsequence** is obtained by deleting zero or more elements without
reordering the rest. A subsequence $a_{i_1}, \ldots, a_{i_k}$ with
$i_1 < \cdots < i_k$ is **strictly increasing** when
$a_{i_1} < \cdots < a_{i_k}$. Report the maximum possible length.

**Input.** The first line has $N$ $(1 \le N \le 10^5)$; the second has $N$
integers $a_1 \ldots a_N$ $(1 \le a_i \le 10^9)$.

**Output.** A single integer: the length of a longest strictly increasing
subsequence.

**Examples.** `1 3 2 5 4 6` → `4`; `5 4 3 2 1` → `1`.

**Limits.** 2 seconds, 256 MiB. Group `nho` (40 points): $N \le 1000$, where
the $O(N^2)$ dynamic program suffices. Group `lon` (60 points): $N \le 10^5$,
which needs an $O(N \log N)$ solution. Note that equal elements do **not**
extend a subsequence — the requirement is strictly increasing, not
non-decreasing.

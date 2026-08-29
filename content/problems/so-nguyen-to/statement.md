# Đếm số nguyên tố

Thư viện của trường đang đánh số lại toàn bộ kệ sách từ $1$ đến $N$. Cô thủ thư
muốn dán nhãn đỏ lên mọi kệ mang số nguyên tố, và trước khi đặt in nhãn, cô cần
biết phải in bao nhiêu cái.

Một số nguyên $p$ được gọi là **số nguyên tố** nếu $p \ge 2$ và $p$ chỉ chia hết
cho $1$ và chính nó.

Cho số nguyên $N$, hãy đếm xem có bao nhiêu số nguyên tố không vượt quá $N$.

## Dữ liệu vào

Một dòng duy nhất chứa số nguyên $N$ $(0 \le N \le 10^7)$.

## Kết quả

In ra một số nguyên duy nhất là số lượng số nguyên tố $p$ thoả mãn $p \le N$.

## Ví dụ

| Dữ liệu vào | Kết quả | Giải thích |
| --- | --- | --- |
| `10` | `4` | Đó là $2, 3, 5, 7$. |
| `1` | `0` | Không có số nguyên tố nào $\le 1$. |

## Giới hạn

- Thời gian: 2 giây. Bộ nhớ: 256 MiB.
- Nhóm `nho` (40 điểm): $N \le 1000$ — kiểm tra từng số bằng phép chia thử vẫn kịp.
- Nhóm `lon` (60 điểm): $N \le 10^7$ — cần sàng Eratosthenes.

---

## English

The school library is renumbering every shelf from $1$ to $N$. The librarian
wants a red label on each shelf whose number is prime, and before ordering the
labels she needs to know how many to print.

An integer $p$ is **prime** when $p \ge 2$ and its only divisors are $1$ and
itself.

**Input.** A single line with one integer $N$ $(0 \le N \le 10^7)$.

**Output.** A single integer: how many primes $p$ satisfy $p \le N$.

**Examples.** `10` → `4` (namely $2, 3, 5, 7$); `1` → `0`.

**Limits.** 2 seconds, 256 MiB. Group `nho` (40 points): $N \le 1000$, where
trial division per number still finishes. Group `lon` (60 points):
$N \le 10^7$, which needs a sieve of Eratosthenes.

# Tổng hai số

Nam vừa được cô giáo giao bài tập đầu tiên trong buổi học lập trình: cộng hai
số nguyên. Bài toán nghe có vẻ tầm thường, nhưng nó là bài kiểm tra xem chương
trình của bạn đọc dữ liệu vào và in dữ liệu ra có đúng khuôn dạng hay không.

Cho hai số nguyên $a$ và $b$. Hãy tính $a + b$.

## Dữ liệu vào

Một dòng duy nhất chứa hai số nguyên $a$ và $b$ cách nhau bởi một dấu cách
$(-10^9 \le a, b \le 10^9)$.

## Kết quả

In ra một số nguyên duy nhất là tổng $a + b$.

## Ví dụ

| Dữ liệu vào | Kết quả |
| --- | --- |
| `2 3` | `5` |
| `-7 4` | `-3` |

## Giới hạn

- Thời gian: 1 giây. Bộ nhớ: 256 MiB.
- Nhóm `nho` (40 điểm): $|a|, |b| \le 1000$.
- Nhóm `lon` (60 điểm): không có ràng buộc thêm.

Lưu ý: $a + b$ có thể vượt quá phạm vi kiểu 32 bit, hãy dùng kiểu 64 bit.

---

## English

Nam has just been given the first exercise of his programming class: add two
integers. It sounds trivial, but it is the test of whether your program reads
input and writes output in the right shape at all.

Given two integers $a$ and $b$, compute $a + b$.

**Input.** A single line with two space-separated integers $a$ and $b$
$(-10^9 \le a, b \le 10^9)$.

**Output.** A single integer, the sum $a + b$.

**Examples.** `2 3` → `5`; `-7 4` → `-3`.

**Limits.** 1 second, 256 MiB. Group `nho` (40 points): $|a|, |b| \le 1000$.
Group `lon` (60 points): no further constraint. Note that $a + b$ can exceed
the 32-bit range — use a 64-bit type.

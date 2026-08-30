# Lời giải — Tổng hai số

Bài này kiểm tra đúng một việc: chương trình của bạn đọc dữ liệu vào và in kết
quả ra có đúng khuôn dạng hay không. Thuật toán chỉ là một phép cộng.

## Hướng làm

Đọc hai số nguyên $a$ và $b$ trên cùng một dòng, in ra $a + b$. Độ phức tạp
$O(1)$ về cả thời gian lẫn bộ nhớ.

## Cái bẫy duy nhất

$|a|, |b| \le 10^9$, nên tổng có thể tới $2 \cdot 10^9$ — vượt quá phạm vi
kiểu 32 bit có dấu (tối đa khoảng $2.147 \cdot 10^9$). Dùng `long long` trong
C++ (hoặc `int64_t`); Python không cần lo vì số nguyên của Python không giới
hạn. Nhóm `nho` với $|a|, |b| \le 1000$ tồn tại chính là để một lời giải dùng
`int` vẫn ăn được 40 điểm thay vì trắng tay.

```cpp
#include <bits/stdc++.h>
int main() {
    long long a, b;
    std::cin >> a >> b;
    std::cout << a + b << '\n';
}
```

---

## Editorial (English)

This problem tests exactly one thing: whether your program reads input and
writes output in the right shape. The algorithm is a single addition.

## Approach

Read the two integers $a$ and $b$ from one line and print $a + b$. Both time
and memory are $O(1)$.

## The one trap

With $|a|, |b| \le 10^9$ the sum reaches $2 \cdot 10^9$, past the range of a
signed 32-bit integer (about $2.147 \cdot 10^9$). Use `long long` in C++ (or
`int64_t`); Python's integers are unbounded and need no care. The `nho` group,
where $|a|, |b| \le 1000$, exists precisely so that an `int` solution still
scores 40 rather than nothing.

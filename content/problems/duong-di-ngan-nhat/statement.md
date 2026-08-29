# Đường đi ngắn nhất

Tỉnh có $N$ thị trấn được đánh số từ $1$ đến $N$ và $M$ tuyến đường hai chiều.
Tuyến đường thứ $j$ nối hai thị trấn $u_j$ và $v_j$, đi hết $w_j$ phút theo cả
hai chiều.

Một đoàn xe xuất phát từ thị trấn $1$ và cần tới thị trấn $N$. Hãy tính thời
gian đi ít nhất, hoặc cho biết không tồn tại hành trình nào.

Giữa hai thị trấn có thể có nhiều hơn một tuyến đường, và một tuyến đường có thể
nối một thị trấn với chính nó.

## Dữ liệu vào

- Dòng đầu chứa hai số nguyên $N$ và $M$ $(1 \le N \le 10^5$, $0 \le M \le 2 \cdot 10^5)$.
- $M$ dòng tiếp theo, dòng thứ $j$ chứa ba số nguyên $u_j$, $v_j$, $w_j$
  $(1 \le u_j, v_j \le N$, $1 \le w_j \le 10^9)$.

## Kết quả

In ra một số nguyên duy nhất là tổng thời gian nhỏ nhất để đi từ thị trấn $1$
đến thị trấn $N$, hoặc `-1` nếu không thể đi được. Nếu $N = 1$ thì kết quả là
$0$.

## Ví dụ

| Dữ liệu vào | Kết quả | Giải thích |
| --- | --- | --- |
| `4 4`<br>`1 2 1`<br>`2 4 5`<br>`1 3 2`<br>`3 4 2` | `4` | Đi $1 \to 3 \to 4$ hết $2 + 2 = 4$, ngắn hơn $1 \to 2 \to 4$ hết $6$. |
| `2 0` | `-1` | Không có tuyến đường nào. |

## Giới hạn

- Thời gian: 2 giây. Bộ nhớ: 256 MiB.
- Nhóm `nho` (40 điểm): $N \le 100$, $M \le 1000$ — Bellman–Ford $O(N \cdot M)$ là đủ.
- Nhóm `lon` (60 điểm): không có ràng buộc thêm — cần Dijkstra với hàng đợi ưu tiên.

Lưu ý: kết quả có thể lên tới khoảng $10^{14}$, vượt phạm vi kiểu 32 bit.

---

## English

The province has $N$ towns numbered $1$ to $N$ and $M$ two-way roads; road $j$
joins towns $u_j$ and $v_j$ and takes $w_j$ minutes in either direction. A
convoy leaves town $1$ and must reach town $N$. Report the minimum travel time,
or say that no route exists. There may be several roads between the same pair
of towns, and a road may join a town to itself.

**Input.** The first line has $N$ and $M$ $(1 \le N \le 10^5$,
$0 \le M \le 2 \cdot 10^5)$. Each of the next $M$ lines has $u_j$, $v_j$, $w_j$
$(1 \le u_j, v_j \le N$, $1 \le w_j \le 10^9)$.

**Output.** A single integer: the smallest total time from town $1$ to town
$N$, or `-1` if it cannot be reached. When $N = 1$ the answer is $0$.

**Limits.** 2 seconds, 256 MiB. Group `nho` (40 points): $N \le 100$,
$M \le 1000$, where $O(N \cdot M)$ Bellman–Ford suffices. Group `lon` (60
points): no further constraint — Dijkstra with a priority queue. Note the
answer can reach roughly $10^{14}$, beyond the 32-bit range.

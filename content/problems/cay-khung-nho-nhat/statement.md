# Cây khung nhỏ nhất

Sở điện lực cần kéo cáp nối $N$ trạm biến áp, đánh số từ $1$ đến $N$. Có $M$
tuyến cáp khả thi; tuyến thứ $j$ nối hai trạm $u_j$ và $v_j$ với chi phí $w_j$.

Hãy chọn một tập tuyến cáp có **tổng chi phí nhỏ nhất** sao cho từ bất kỳ trạm
nào cũng đi được tới mọi trạm còn lại theo các tuyến đã chọn. Nếu điều đó không
thể thực hiện được với các tuyến khả thi, hãy báo lại.

Giữa hai trạm có thể có nhiều hơn một tuyến cáp, và một tuyến có thể nối một
trạm với chính nó (tuyến như vậy không bao giờ hữu ích).

## Dữ liệu vào

- Dòng đầu chứa hai số nguyên $N$ và $M$ $(1 \le N \le 10^5$, $0 \le M \le 2 \cdot 10^5)$.
- $M$ dòng tiếp theo, dòng thứ $j$ chứa ba số nguyên $u_j$, $v_j$, $w_j$
  $(1 \le u_j, v_j \le N$, $1 \le w_j \le 10^9)$.

## Kết quả

In ra một số nguyên duy nhất là tổng chi phí nhỏ nhất để nối toàn bộ $N$ trạm,
hoặc `-1` nếu không thể nối tất cả các trạm. Nếu $N = 1$ thì kết quả là $0$.

## Ví dụ

| Dữ liệu vào | Kết quả | Giải thích |
| --- | --- | --- |
| `4 5`<br>`1 2 1`<br>`2 3 2`<br>`3 4 3`<br>`4 1 4`<br>`1 3 5` | `6` | Chọn ba tuyến chi phí $1 + 2 + 3$. |
| `3 1`<br>`1 2 7` | `-1` | Trạm $3$ bị cô lập. |

## Giới hạn

- Thời gian: 2 giây. Bộ nhớ: 256 MiB.
- Nhóm `nho` (40 điểm): $N \le 100$, $M \le 1000$ — Prim $O(N^2)$ là đủ.
- Nhóm `lon` (60 điểm): không có ràng buộc thêm — cần Kruskal với cấu trúc
  DSU, hoặc Prim với hàng đợi ưu tiên.

Lưu ý: tổng chi phí có thể lên tới khoảng $10^{14}$, vượt phạm vi kiểu 32 bit.

---

## English

The power company must cable $N$ substations numbered $1$ to $N$. There are $M$
candidate cables; cable $j$ joins substations $u_j$ and $v_j$ at cost $w_j$.

Choose a set of cables of **minimum total cost** such that every substation can
reach every other one along the chosen cables, or report that this is
impossible. There may be several cables between the same pair, and a cable may
join a substation to itself (such a cable is never useful).

**Input.** The first line has $N$ and $M$ $(1 \le N \le 10^5$,
$0 \le M \le 2 \cdot 10^5)$. Each of the next $M$ lines has $u_j$, $v_j$, $w_j$
$(1 \le u_j, v_j \le N$, $1 \le w_j \le 10^9)$.

**Output.** A single integer: the minimum total cost of connecting all $N$
substations, or `-1` if they cannot all be connected. When $N = 1$ the answer
is $0$.

**Limits.** 2 seconds, 256 MiB. Group `nho` (40 points): $N \le 100$,
$M \le 1000$, where $O(N^2)$ Prim suffices. Group `lon` (60 points): no further
constraint — Kruskal with a DSU, or Prim with a priority queue. Note the total
can reach roughly $10^{14}$, beyond the 32-bit range.

#!/usr/bin/env python3
"""duong-di-ngan-nhat — 2 samples + 10 generated tests.

    python3 content/problems/duong-di-ngan-nhat/gen.py

The largest committed test is N = 2000 / M = 5000, not the stated bound of
1e5 / 2e5: these files live in git. Raise `LARGE_N`/`LARGE_M` and re-run to
produce bound-sized data for a real judge run.

Fixed seed, so re-running reproduces the committed tests byte for byte.
"""

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import gen_common  # noqa: E402

WEIGHT_LIMIT = 10**9
LARGE_N = 2000
LARGE_M = 5000
random.seed(20260829)


def case(n: int, edges: list[tuple[int, int, int]]) -> str:
    lines = [f"{n} {len(edges)}"]
    lines += [f"{u} {v} {w}" for u, v, w in edges]
    return "\n".join(lines)


def connected(n: int, m: int, max_weight: int) -> str:
    """A random spanning path first, then random extra edges on top.

    Building the tree before the noise guarantees the graph is connected,
    so these tests exercise the *distance*, not the -1 branch.
    """
    order = list(range(1, n + 1))
    random.shuffle(order)
    edges = [
        (order[i], order[i + 1], random.randint(1, max_weight))
        for i in range(n - 1)
    ]
    while len(edges) < m:
        u = random.randint(1, n)
        v = random.randint(1, n)
        if u == v:
            continue
        edges.append((u, v, random.randint(1, max_weight)))
    random.shuffle(edges)
    return case(n, edges)


cases: list[str] = [
    # 01-02: the samples — one with a genuine detour, one unreachable.
    case(4, [(1, 2, 1), (2, 4, 5), (1, 3, 2), (3, 4, 2)]),
    case(2, []),
    # 03-07 (group "nho"): a single vertex (answer 0), a disconnected graph
    # (-1), a multi-edge where the cheaper parallel edge must win, and two
    # small random connected graphs.
    case(1, []),
    case(3, [(1, 2, 7)]),
    case(2, [(1, 2, 9), (1, 2, 3), (1, 2, 5)]),
    connected(10, 20, 100),
    connected(50, 120, 10**6),
]
# 08-12 (group "lon"): sizes where an O(N*M) Bellman-Ford is too slow, and
# one long path of maximal weights where the answer overflows 32 bits.
cases += [
    connected(LARGE_N, LARGE_M, WEIGHT_LIMIT),
    connected(LARGE_N, LARGE_M, 10**3),
    connected(LARGE_N, LARGE_N - 1, WEIGHT_LIMIT),
    case(LARGE_N, [(i, i + 1, WEIGHT_LIMIT) for i in range(1, LARGE_N)]),
]
cases.append(connected(1000, LARGE_M, WEIGHT_LIMIT))

gen_common.write_tests(__file__, cases)

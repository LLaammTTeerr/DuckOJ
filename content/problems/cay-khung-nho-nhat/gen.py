#!/usr/bin/env python3
"""cay-khung-nho-nhat — 2 samples + 10 generated tests.

    python3 content/problems/cay-khung-nho-nhat/gen.py

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
    """A random spanning tree first, then random extra edges on top."""
    order = list(range(1, n + 1))
    random.shuffle(order)
    edges = [
        (order[random.randint(0, i - 1)], order[i], random.randint(1, max_weight))
        for i in range(1, n)
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
    # 01-02: the samples — one ordinary cycle, one disconnected graph.
    case(4, [(1, 2, 1), (2, 3, 2), (3, 4, 3), (4, 1, 4), (1, 3, 5)]),
    case(3, [(1, 2, 7)]),
    # 03-07 (group "nho"): a single vertex (weight 0), a graph that is
    # already a tree, parallel edges where only the cheapest may be taken,
    # a self-loop that must never enter the tree, and a small random graph.
    case(1, []),
    case(4, [(1, 2, 5), (2, 3, 6), (3, 4, 7)]),
    case(2, [(1, 2, 9), (1, 2, 3), (1, 2, 5)]),
    case(3, [(1, 1, 1), (1, 2, 4), (2, 3, 4), (2, 2, 2)]),
    connected(40, 100, 10**6),
]
# 08-12 (group "lon"): sizes where an O(N*M) Prim is too slow, plus a total
# weight that overflows 32 bits (1999 edges of 1e9 ~ 2e12).
cases += [
    connected(LARGE_N, LARGE_M, WEIGHT_LIMIT),
    connected(LARGE_N, LARGE_M, 10**3),
    connected(LARGE_N, LARGE_N - 1, WEIGHT_LIMIT),
    case(LARGE_N, [(i, i + 1, WEIGHT_LIMIT) for i in range(1, LARGE_N)]),
]
# One large graph that is deliberately disconnected: two halves, no bridge.
_half = LARGE_N // 2
_left = [(random.randint(1, _half), random.randint(1, _half), random.randint(1, WEIGHT_LIMIT)) for _ in range(1500)]
_right = [
    (random.randint(_half + 1, LARGE_N), random.randint(_half + 1, LARGE_N), random.randint(1, WEIGHT_LIMIT))
    for _ in range(1500)
]
cases.append(case(LARGE_N, _left + _right))

gen_common.write_tests(__file__, cases)

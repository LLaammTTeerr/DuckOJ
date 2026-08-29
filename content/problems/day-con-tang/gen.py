#!/usr/bin/env python3
"""day-con-tang — 2 samples + 10 generated tests.

    python3 content/problems/day-con-tang/gen.py

The largest committed test is N = 5000, not the stated bound of 1e5: these
files live in git, and 1e5 nine-digit numbers is a megabyte per test. Raise
`LARGE_N` and re-run to produce bound-sized data for a real judge run —
that is the knob, and it is the only thing that has to change.

Fixed seed, so re-running reproduces the committed tests byte for byte.
"""

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import gen_common  # noqa: E402

VALUE_LIMIT = 10**9
LARGE_N = 5000
random.seed(20260829)


def case(values: list[int]) -> str:
    return f"{len(values)}\n" + " ".join(str(v) for v in values)


cases: list[str] = [
    # 01-02: the samples.
    case([1, 3, 2, 5, 4, 6]),
    case([5, 4, 3, 2, 1]),
    # 03-07 (group "nho"): N small enough for an O(N^2) solution, plus the
    # two shapes that separate *strictly* increasing from non-decreasing.
    case([7]),
    case([4, 4, 4, 4, 4, 4]),
    case([1, 2, 2, 3, 3, 4]),
    case(sorted(random.sample(range(1, VALUE_LIMIT), 60))),
    case([random.randint(1, 20) for _ in range(200)]),
]
# 08-12 (group "lon"): N where O(N^2) is too slow. The fully sorted and
# fully reversed cases are the two extremes of the answer's range.
cases += [
    case(sorted(random.sample(range(1, VALUE_LIMIT), LARGE_N))),
    case(sorted(random.sample(range(1, VALUE_LIMIT), LARGE_N), reverse=True)),
    case([random.randint(1, VALUE_LIMIT) for _ in range(LARGE_N)]),
    case([random.randint(1, 50) for _ in range(LARGE_N)]),
]
_stair = [((i * 7919) % LARGE_N) + 1 for i in range(LARGE_N)]
cases.append(case(_stair))

gen_common.write_tests(__file__, cases)

#!/usr/bin/env python3
"""tong-hai-so — 2 samples + 10 generated tests.

    python3 content/problems/tong-hai-so/gen.py

The seed is fixed, so re-running this reproduces the committed tests byte
for byte; a generator whose output drifts between runs would make every
diff on `tests/` unreviewable.
"""

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import gen_common  # noqa: E402

LIMIT = 10**9
random.seed(20260829)


def case(a: int, b: int) -> str:
    return f"{a} {b}"


cases: list[str] = [
    # 01-02: the two samples, quoted verbatim in the statement.
    case(2, 3),
    case(-7, 4),
    # 03-07 (group "nho"): small values and the sign combinations a solution
    # that assumed non-negative input would get wrong.
    case(0, 0),
    case(1, -1),
    case(-5, -6),
    case(123, 456),
    case(-1000, 999),
]
# 08-12 (group "lon"): the bounds themselves, where a 32-bit accumulator
# overflows — 1e9 + 1e9 does not fit in `int`.
cases += [
    case(LIMIT, LIMIT),
    case(-LIMIT, -LIMIT),
    case(LIMIT, -LIMIT),
]
cases += [case(random.randint(-LIMIT, LIMIT), random.randint(-LIMIT, LIMIT)) for _ in range(2)]

gen_common.write_tests(__file__, cases)

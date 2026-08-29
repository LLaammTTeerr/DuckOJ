#!/usr/bin/env python3
"""so-nguyen-to — 2 samples + 10 generated tests.

    python3 content/problems/so-nguyen-to/gen.py

Fixed seed, so re-running reproduces the committed tests byte for byte.
"""

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import gen_common  # noqa: E402

LIMIT = 10**7
random.seed(20260829)

cases: list[str] = [
    # 01-02: the samples.
    "10",
    "1",
    # 03-07 (group "nho"): the boundary values a naive trial-division
    # solution still survives, including the two below the first prime.
    "0",
    "2",
    "3",
    "100",
    "1000",
]
# 08-12 (group "lon"): sizes where trial division per number is far too
# slow and only a sieve finishes, ending exactly on the stated bound.
cases += ["1000000", "9999991"]
cases += [str(random.randint(10**6, LIMIT)) for _ in range(2)]
cases.append(str(LIMIT))

gen_common.write_tests(__file__, cases)

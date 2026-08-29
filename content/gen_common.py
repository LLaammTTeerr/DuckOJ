"""Shared plumbing for the five demo problems' generators.

Each `content/problems/<code>/gen.py` decides *what* the tests are; this
decides how they get onto disk. The two are split because the plumbing is
where a subtle mistake would be invisible: an answer file written from a
stale binary, or a test numbered `1` where the `%02d` pattern in
`problem.xml` says `01`, both look fine in a directory listing and both
break at grade time.

Answers are never hand-written. Every `NN.a` is the model solution's own
stdout on `NN`, produced by this module in the same run that wrote `NN`, so
a test and its answer cannot disagree about which version of the solution
they came from.

This file lives outside `content/problems/<code>/` on purpose. Only paths
named in `problem.xml` are copied into a DuckOJ package, so nothing here
reaches the judge — but keeping the generator's library out of the problem
directories makes that independent of the importer's behaviour rather than
reliant on it.

Usage from a generator:

    import gen_common
    gen_common.write_tests(__file__, cases)   # cases: list[str], 1-indexed
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path


def compile_solution(problem_dir: Path) -> Path:
    """g++ the model solution into a temp binary and return its path."""
    source = problem_dir / "solution.cpp"
    if not source.exists():
        raise SystemExit(f"no model solution at {source}")
    binary = Path(tempfile.mkdtemp(prefix="duckoj-sol-")) / "solution"
    subprocess.run(
        ["g++", "-O2", "-std=c++17", "-o", str(binary), str(source)],
        check=True,
    )
    return binary


def write_tests(generator_file: str, cases: list[str]) -> None:
    """Write `tests/NN` and `tests/NN.a` for every case, 1-indexed, `%02d`.

    `cases` are complete input files. They are written verbatim apart from a
    guaranteed trailing newline: a missing one is the classic way a test
    that reads fine locally makes a solution hang on a judge.
    """
    problem_dir = Path(generator_file).resolve().parent
    binary = compile_solution(problem_dir)
    tests_dir = problem_dir / "tests"
    tests_dir.mkdir(exist_ok=True)

    for index, raw in enumerate(cases, start=1):
        text = raw if raw.endswith("\n") else raw + "\n"
        name = f"{index:02d}"
        (tests_dir / name).write_text(text, encoding="utf-8")
        result = subprocess.run(
            [str(binary)],
            input=text,
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        )
        (tests_dir / f"{name}.a").write_text(result.stdout, encoding="utf-8")
        print(f"{name}: {len(text)} bytes in -> {result.stdout.strip()!r}", file=sys.stderr)

    print(f"wrote {len(cases)} tests to {tests_dir}", file=sys.stderr)

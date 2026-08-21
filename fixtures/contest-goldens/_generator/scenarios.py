#!/usr/bin/env python3
"""Author the scenario inputs (``contest.json``) for the contest goldens.

Run on the host, no dependencies:

    python3 fixtures/contest-goldens/_generator/scenarios.py fixtures/contest-goldens

The emitted ``contest.json`` files are the source of truth for the goldens —
``generate.py`` only reads them.  This script exists so the twenty-odd fixtures
stay consistent with each other; editing a ``contest.json`` by hand is fine, but
re-running this script will overwrite it.

Every scenario carries a ``sensitivity`` block naming one submission and a shift
in seconds.  ``verify.py`` applies it and asserts the scoreboard changes (§6.2).
"""
from __future__ import annotations

import datetime
import json
import pathlib
import sys

START = datetime.datetime(2026, 3, 1, 9, 0, 0, tzinfo=datetime.timezone.utc)
END = START + datetime.timedelta(hours=5)


def iso(dt: datetime.datetime) -> str:
    return dt.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def at(minutes=0, seconds=0) -> str:
    """An instant, relative to the contest start."""
    return iso(START + datetime.timedelta(minutes=minutes, seconds=seconds))


def absolute(hour, minute=0, second=0) -> str:
    return iso(datetime.datetime(2026, 3, 1, hour, minute, second, tzinfo=datetime.timezone.utc))


# --------------------------------------------------------------------------- #
# case shorthands.  A "loose" case has no batch; batches are numbered from 1
# because the judge bridge treats batch 0 as loose (`if not case.batch`).
# --------------------------------------------------------------------------- #
def full(total=100):
    return [{'batch': None, 'case': 1, 'points': total, 'total': total, 'status': 'AC'}]


def zero(total=100):
    return [{'batch': None, 'case': 1, 'points': 0, 'total': total, 'status': 'WA'}]


def partial_(got, total=100):
    return [{'batch': None, 'case': 1, 'points': got, 'total': total, 'status': 'WA'}]


def batch(number, got, total, cases=2):
    """`cases` test cases in one batch, each carrying the batch's point value."""
    return [
        {'batch': number, 'points': got, 'total': total, 'status': 'AC' if got else 'WA'}
        for _ in range(cases)
    ]


def sub(participant, problem, when, cases, result='AC', status='D'):
    return {
        'participant': participant,
        'problem': problem,
        'date': when,
        'result': result,
        'status': status,
        'cases': cases,
    }


def live(name, real_start=None):
    return {'name': name, 'virtual': 0, 'real_start': real_start or iso(START)}


def virtual(name, n, real_start):
    return {'name': name, 'virtual': n, 'real_start': real_start}


def contest(key, *, time_limit=None, precision=3):
    return {
        'key': key,
        'name': key,
        'start_time': iso(START),
        'end_time': iso(END),
        'time_limit_seconds': time_limit,
        'points_precision': precision,
        # Always 0: `Contest.is_frozen` compares `timezone.now()` to the freeze
        # instant, so a non-zero value would make the goldens depend on the wall
        # clock and break §6.1 reproducibility.
        'frozen_last_minutes': 0,
    }


def problem(code, points, *, partial=True, cases=None):
    spec = {'code': code, 'name': code, 'points': points,
            'partial': partial, 'problem_partial': partial}
    if cases is not None:
        spec['problem_test_cases'] = cases
    return spec


def batched_dataset(*batch_points, loose=()):
    """ProblemTestCase rows: `points_scaling_factor` sums batch and loose points."""
    rows = []
    for points in loose:
        rows.append({'type': 'C', 'points': points})
    for points in batch_points:
        rows.append({'type': 'S', 'points': points})
        rows.append({'type': 'C', 'points': 0})
        rows.append({'type': 'C', 'points': 0})
        rows.append({'type': 'E', 'points': 0})
    return rows


SCENARIOS: list[dict] = []


def scenario(directory, fmt, name, description, findings, **rest):
    SCENARIOS.append({
        'directory': directory,
        'scenario': name,
        'format': fmt,
        'description': description,
        'findings': findings,
        **rest,
    })


# =========================================================================== #
# default
# =========================================================================== #
scenario(
    'default/01-nobody-solves', 'default', '01-nobody-solves',
    'Three participants, nothing solved. Tests the all-zero board and the order '
    'of rows that tie on every ranking key.',
    [
        'A zero-point submission still creates a format_data entry, so "has a cell" '
        'is not the same as "scored".',
        'cumtime only accumulates for problems with a non-zero score, so it stays 0.',
        'Rows tied on (score, cumtime, tiebreaker) are ordered by -submission_count: '
        'more submissions ranks higher.',
    ],
    format_config={},
    contest=contest('default-01'),
    problems=[problem('a', 100), problem('b', 100)],
    participants=[live('alice'), live('bob'), live('carol')],
    submissions=[
        sub('alice', 'a', at(5), zero(), result='WA'),
        sub('alice', 'a', at(15), zero(), result='WA'),
        sub('alice', 'b', at(25), zero(), result='TLE'),
        sub('bob', 'a', at(10), zero(), result='WA'),
    ],
    sensitivity={
        'submission_index': 2, 'shift_seconds': 60,
        'why': "alice's last submission on b moves one minute later, changing "
               "format_data['b']['time'] even though no score changes.",
    },
)

scenario(
    'default/02-score-tie', 'default', '02-score-tie',
    'Two participants tie on score and cumtime; a third ties on score only.',
    [
        'default breaks a score tie by cumtime = the sum, over problems with a '
        'non-zero score, of the last submission time on that problem.',
        'tiebreaker is hard-coded to 0, so it never separates anyone.',
        'A perfect tie falls through to -submission_count.',
    ],
    format_config={},
    contest=contest('default-02'),
    problems=[problem('a', 100), problem('b', 100), problem('c', 100)],
    participants=[live('alice'), live('bob'), live('carol')],
    submissions=[
        sub('alice', 'a', at(10), full()),
        sub('alice', 'b', at(30), full()),
        sub('bob', 'a', at(25), full()),
        sub('bob', 'b', at(20), full()),
        sub('bob', 'c', at(50), zero(), result='WA'),
        sub('carol', 'a', at(20), full()),
        sub('carol', 'b', at(25), full()),
    ],
    sensitivity={
        'submission_index': 3, 'shift_seconds': 600,
        'why': "bob's accept on b moves ten minutes later, breaking his tie with carol.",
    },
)

scenario(
    'default/03-deadline-boundary', 'default', '03-deadline-boundary',
    'One accept at exactly the contest end instant, one a second after it.',
    [
        'update_participation applies NO end-time filter: a submission after the '
        'deadline scores normally if a ContestSubmission row exists. Gating happens '
        'when the submission is created, not when the scoreboard is computed.',
        'The one-second difference is visible in cumtime because default keeps '
        'seconds (unlike icpc, which floors to minutes).',
    ],
    format_config={},
    contest=contest('default-03'),
    problems=[problem('a', 100)],
    participants=[live('alice'), live('bob'), live('carol')],
    submissions=[
        sub('alice', 'a', absolute(14, 0, 0), full()),
        sub('bob', 'a', absolute(14, 0, 1), full()),
        sub('carol', 'a', absolute(15, 30, 0), full()),
    ],
    sensitivity={
        'submission_index': 0, 'shift_seconds': -1,
        'why': "alice's accept moves one second earlier; her cumtime drops by 1.",
    },
)

scenario(
    'default/04-late-joiner', 'default', '04-late-joiner',
    'A windowed contest (time_limit set) where participants start at different times.',
    [
        'ContestParticipation.start returns contest.start_time for a live '
        'participant only when contest.time_limit is None. With a time_limit set it '
        'returns real_start, so every relative time is measured from the join.',
        'A late joiner with the same elapsed time gets the same cumtime as an early one.',
    ],
    format_config={},
    contest=contest('default-04', time_limit=7200),
    problems=[problem('a', 100), problem('b', 100)],
    participants=[
        live('alice', absolute(9, 0, 0)),
        live('bob', absolute(10, 0, 0)),
        live('carol', absolute(11, 0, 0)),
    ],
    submissions=[
        sub('alice', 'a', absolute(9, 30, 0), full()),
        sub('bob', 'a', absolute(10, 30, 0), full()),
        sub('bob', 'b', absolute(10, 5, 0), zero(), result='WA'),
        sub('carol', 'a', absolute(11, 45, 0), full()),
    ],
    sensitivity={
        'submission_index': 1, 'shift_seconds': 300,
        'why': "bob's accept moves five minutes later, so his cumtime overtakes alice's.",
    },
)

scenario(
    'default/05-virtual-participation', 'default', '05-virtual-participation',
    'A virtual participation running after the contest, alongside two live ones.',
    [
        'A virtual participation is ranked with everyone else and can outrank live '
        'participants, but is excluded from first_solve (`participation.virtual == 0`).',
        'It is NOT excluded from total_ac, which counts virtuals.',
        'A virtual participation measures time from real_start regardless of '
        'contest.time_limit, because ContestParticipation.start only special-cases '
        'live and spectating rows.',
    ],
    format_config={},
    contest=contest('default-05'),
    problems=[problem('a', 100)],
    participants=[live('alice'), live('bob'), virtual('mallory', 1, absolute(20, 0, 0))],
    submissions=[
        sub('alice', 'a', at(30), full()),
        sub('bob', 'a', at(45), full()),
        sub('mallory', 'a', absolute(20, 10, 0), full()),
    ],
    sensitivity={
        'submission_index': 2, 'shift_seconds': 1500,
        'why': "the virtual accept moves 25 minutes later, dropping mallory below "
               'both live participants without touching first_solve.',
    },
)

scenario(
    'default/06-zero-after-accept', 'default', '06-zero-after-accept',
    'A worthless submission sent AFTER an accept, on the same problem.',
    [
        "default's `Max('submission__date')` and `Max('points')` are INDEPENDENT "
        'aggregates. The recorded time is the last submission on the problem, not '
        'the time of the best one — so a zero-point resubmission after an accept '
        'raises your cumtime and can cost you the contest.',
        'legacy_ioi/06-zero-after-accept has identical inputs and does not do this: '
        'it takes Min(date) among the best-scoring submissions.',
    ],
    format_config={},
    contest=contest('default-06'),
    problems=[problem('a', 100)],
    participants=[live('alice'), live('bob')],
    submissions=[
        sub('alice', 'a', at(10), full()),
        sub('alice', 'a', at(100), zero(), result='WA'),
        sub('bob', 'a', at(90), full()),
    ],
    sensitivity={
        'submission_index': 1, 'shift_seconds': -1500,
        'why': "alice's post-accept junk moves 25 minutes earlier, dropping her "
               'cumtime below bob and flipping the ranking.',
    },
)

# =========================================================================== #
# icpc
# =========================================================================== #
ICPC = {'penalty': 20}


def icpc_problem(code, points=100):
    return problem(code, points, partial=False)


scenario(
    'icpc/01-nobody-solves', 'icpc', '01-nobody-solves',
    'Failed attempts only. Tests that unsolved problems carry no penalty.',
    [
        'Penalty is added ONLY inside the `if points:` branch. Attempts on a problem '
        'you never solve add ZERO penalty — a reimplementation that charges 20 '
        'minutes per wrong answer regardless is wrong.',
        'tries is still recorded (and displayed) for unsolved problems.',
        'The golden corrected a misreading: for an unsolved problem icpc reassigns '
        'the local `time` to Max(date), but `dt_second` — the value that reaches '
        'format_data — was already computed from the raw SQL\'s Min(date). The '
        'reassignment only feeds the frozen-scoreboard flag, so format_data.time '
        'records the FIRST attempt, not the last. Moving the last attempt an hour '
        'later changes nothing at all (see the null probe).',
    ],
    format_config=ICPC,
    contest=contest('icpc-01'),
    problems=[icpc_problem('a'), icpc_problem('b')],
    participants=[live('alice'), live('bob'), live('carol')],
    submissions=[
        sub('alice', 'a', at(5), zero(), result='WA'),
        sub('alice', 'a', at(15), zero(), result='WA'),
        sub('alice', 'a', at(25), zero(), result='TLE'),
        sub('bob', 'b', at(10), zero(), result='RTE'),
    ],
    sensitivity={
        'submission_index': 0, 'shift_seconds': 60,
        'why': "alice's FIRST failed attempt moves one minute later; the recorded "
               'time for an unsolved problem follows the earliest attempt.',
    },
    null_probe={
        'submission_index': 2, 'shift_seconds': 3600,
        'why': "alice's LAST failed attempt moves an hour later.",
        'because': 'for a zero-score problem the time that reaches format_data was '
                   'already computed from Min(date); the later reassignment to '
                   'Max(date) only affects the frozen-scoreboard flag.',
    },
)

scenario(
    'icpc/02-score-tie', 'icpc', '02-score-tie',
    'Two participants on equal score and equal cumtime, separated by the tiebreaker.',
    [
        'cumtime = sum of solve minutes + penalty minutes. The tiebreaker is the '
        'LARGEST solve time in minutes (`last`), not a sum — so it separates two '
        'boards with the same total.',
        'Solve time is floored to whole minutes (`int(dt // 60)`) before it enters '
        'cumtime, while format_data keeps the exact seconds.',
    ],
    format_config=ICPC,
    contest=contest('icpc-02'),
    problems=[icpc_problem('a'), icpc_problem('b')],
    participants=[live('alice'), live('bob'), live('carol')],
    submissions=[
        sub('alice', 'a', at(10), full()),
        sub('alice', 'b', at(60), full()),
        sub('bob', 'a', at(30), full()),
        sub('bob', 'b', at(40), full()),
        sub('carol', 'a', at(5), zero(), result='WA'),
        sub('carol', 'a', at(25), full()),
    ],
    sensitivity={
        'submission_index': 3, 'shift_seconds': 1200,
        'why': "bob's second accept moves 20 minutes later, changing both his "
               'cumtime and his tiebreaker.',
    },
)

scenario(
    'icpc/03-deadline-boundary', 'icpc', '03-deadline-boundary',
    'Accepts at the deadline, one second after, 59 seconds after, and a minute after.',
    [
        'Because solve time is floored to minutes, a submission ONE SECOND after the '
        'deadline scores an identical cumtime and tiebreaker. Only format_data.time '
        'differs. This is the sharpest divergence from a seconds-based reimplementation.',
        'Nothing filters submissions by the contest end.',
        'Three rows tie on every ranking key and are ordered by -submission_count; '
        'the ranker then jumps straight from rank 1 to rank 4.',
    ],
    format_config=ICPC,
    contest=contest('icpc-03'),
    problems=[icpc_problem('a'), icpc_problem('b')],
    participants=[live('alice'), live('bob'), live('carol'), live('dave')],
    submissions=[
        sub('alice', 'a', absolute(14, 0, 0), full()),
        sub('bob', 'a', absolute(14, 0, 1), full()),
        sub('bob', 'b', absolute(9, 5, 0), zero(), result='WA'),
        sub('carol', 'a', absolute(14, 0, 59), full()),
        sub('carol', 'b', absolute(9, 6, 0), zero(), result='WA'),
        sub('carol', 'b', absolute(9, 7, 0), zero(), result='WA'),
        sub('dave', 'a', absolute(14, 1, 0), full()),
    ],
    sensitivity={
        'submission_index': 3, 'shift_seconds': 1,
        'why': "carol's accept crosses the 14:01:00 minute boundary, so her cumtime "
               'and tiebreaker each rise by one and she loses the tie.',
    },
)

scenario(
    'icpc/04-late-joiner', 'icpc', '04-late-joiner',
    'A windowed icpc contest where the later joiner wins on elapsed time.',
    [
        'Same rule as default: with contest.time_limit set, a live participation '
        'measures from real_start.',
        'A participant who joined an hour later and solved in 20 minutes beats one '
        'who joined at the gun and solved in 30.',
    ],
    format_config=ICPC,
    contest=contest('icpc-04', time_limit=7200),
    problems=[icpc_problem('a')],
    participants=[live('alice', absolute(9, 0, 0)), live('bob', absolute(10, 0, 0))],
    submissions=[
        sub('alice', 'a', absolute(9, 30, 0), full()),
        sub('bob', 'a', absolute(10, 20, 0), full()),
    ],
    sensitivity={
        'submission_index': 1, 'shift_seconds': 900,
        'why': "bob's accept moves 15 minutes later; measured from his own start he "
               'now trails alice.',
    },
)

scenario(
    'icpc/05-virtual-participation', 'icpc', '05-virtual-participation',
    'A virtual participation among live ones.',
    [
        'icpc inherits default\'s first-solve rule verbatim: virtuals are counted in '
        'total_ac but can never be the first solver.',
    ],
    format_config=ICPC,
    contest=contest('icpc-05'),
    problems=[icpc_problem('a')],
    participants=[live('alice'), live('bob'), virtual('mallory', 1, absolute(20, 0, 0))],
    submissions=[
        sub('alice', 'a', at(40), full()),
        sub('bob', 'a', at(70), full()),
        sub('mallory', 'a', absolute(20, 5, 0), full()),
    ],
    sensitivity={
        'submission_index': 0, 'shift_seconds': 2400,
        'why': "alice's accept moves 40 minutes later, handing the first solve to bob.",
    },
)

scenario(
    'icpc/06-penalty-before-accept', 'icpc', '06-penalty-before-accept',
    'Wrong answers before an accept, plus a compile error and an internal error '
    'that must not be counted.',
    [
        'tries counts every graded submission dated at or before the accept, '
        'INCLUDING the accept itself; penalty is (tries - 1) * penalty_minutes.',
        'Compile errors (CE) and internal errors (IE), and submissions with a NULL '
        'result, are excluded from tries — so they are free. Most reimplementations '
        'charge for compile errors.',
        'Penalty can invert the standings: alice solved 35 minutes earlier than bob '
        'and still loses.',
    ],
    format_config=ICPC,
    contest=contest('icpc-06'),
    problems=[icpc_problem('a')],
    participants=[live('alice'), live('bob')],
    submissions=[
        sub('alice', 'a', at(3), zero(), result='CE'),
        sub('alice', 'a', at(4), zero(), result=None, status='IE'),
        sub('alice', 'a', at(5), zero(), result='WA'),
        sub('alice', 'a', at(10), zero(), result='WA'),
        sub('alice', 'a', at(20), full()),
        sub('bob', 'a', at(55), full()),
    ],
    sensitivity={
        'submission_index': 3, 'shift_seconds': 900,
        'why': "alice's second wrong answer moves to 25 minutes, AFTER her accept, "
               'so it stops counting: her penalty drops by 20 minutes and she wins.',
    },
)

scenario(
    'icpc/07-no-penalty-after-accept', 'icpc', '07-no-penalty-after-accept',
    'Wrong answers sent after the accept on the same problem.',
    [
        'Submissions after the first maximum-score submission do NOT add penalty: '
        'tries filters on `submission__date__lte=time`, where time is the earliest '
        'submission carrying the maximum score.',
        'They also do not move the recorded time, because the raw SQL takes '
        'MIN(date) over the submissions holding the maximum points.',
        'Contrast default/06-zero-after-accept, where the same shape of input DOES '
        'move the time.',
    ],
    format_config=ICPC,
    contest=contest('icpc-07'),
    problems=[icpc_problem('a')],
    participants=[live('alice'), live('bob')],
    submissions=[
        sub('alice', 'a', at(20), full()),
        sub('alice', 'a', at(40), zero(), result='WA'),
        sub('alice', 'a', at(50), zero(), result='WA'),
        sub('bob', 'a', at(25), full()),
    ],
    sensitivity={
        'submission_index': 0, 'shift_seconds': -600,
        'why': "alice's accept moves ten minutes earlier; her cumtime drops by ten "
               'while the two later wrong answers stay free.',
    },
    null_probe={
        'submission_index': 1, 'shift_seconds': 600,
        'why': "alice's first post-accept wrong answer moves ten minutes later.",
        'because': 'submissions after the first maximum-score submission are invisible '
                   'to icpc: they neither add penalty nor move the recorded time.',
    },
)

scenario(
    'icpc/08-problem-nobody-solves', 'icpc', '08-problem-nobody-solves',
    'Two problems: one solved by everyone, one solved by nobody, with a participant '
    'who never attempted it at all.',
    [
        'total_ac is 0 and first_solve is null for the unsolved problem.',
        'A participant with NO submission on a problem has no format_data key for it '
        'at all (the raw SQL INNER JOINs judge_contestsubmission), while a '
        'participant who attempted and failed has a key with points 0 and tries > 0. '
        '"Absent" and "zero" are different states.',
    ],
    format_config=ICPC,
    contest=contest('icpc-08'),
    problems=[icpc_problem('a'), icpc_problem('b')],
    participants=[live('alice'), live('bob'), live('carol')],
    submissions=[
        sub('alice', 'a', at(15), full()),
        sub('alice', 'b', at(80), zero(), result='WA'),
        sub('alice', 'b', at(95), zero(), result='WA'),
        sub('bob', 'a', at(35), full()),
        sub('bob', 'b', at(60), zero(), result='TLE'),
        sub('carol', 'a', at(50), full()),
    ],
    sensitivity={
        'submission_index': 0, 'shift_seconds': 1800,
        'why': "alice's accept moves 30 minutes later, transferring the first solve "
               'on a to bob and reordering the board.',
    },
)

# =========================================================================== #
# legacy_ioi  (registered under the name "ioi")
# =========================================================================== #
IOI_TIMED = {'cumtime': True, 'last_score_altering': True}

scenario(
    'legacy_ioi/01-nobody-solves', 'ioi', '01-nobody-solves',
    'Failed attempts only, with cumtime and last_score_altering enabled.',
    [
        'A zero-score problem records time 0 explicitly (the `else: dt = 0` branch), '
        'not the submission time — unlike default, which records the real time.',
        'cumtime and the tiebreaker stay 0 because neither accumulates for a '
        'zero-score problem.',
    ],
    format_config=IOI_TIMED,
    contest=contest('legacy-ioi-01'),
    problems=[problem('a', 100), problem('b', 100)],
    participants=[live('alice'), live('bob')],
    submissions=[
        sub('alice', 'a', at(5), zero(), result='WA'),
        sub('alice', 'a', at(15), zero(), result='WA'),
        sub('bob', 'b', at(10), zero(), result='WA'),
    ],
    sensitivity={
        'submission_index': 1, 'batch_flip': {'batch': None, 'points': 40},
        'why': "alice's second attempt scores 40 instead of 0, which turns on the "
               'time-recording branch for that problem.',
    },
    null_probe={
        'submission_index': 0, 'shift_seconds': 3600,
        'why': 'a failed submission moves an hour later.',
        'because': 'legacy_ioi pins the recorded time of a zero-score problem to 0 '
                   "(`else: dt = 0`), so a failed submission's timing is unobservable.",
    },
)

scenario(
    'legacy_ioi/02-score-tie', 'ioi', '02-score-tie',
    'Partial scores tying on total, separated by cumtime and then by tiebreaker.',
    [
        'cumtime = sum over non-zero problems of the time of the EARLIEST submission '
        'achieving that problem\'s best score.',
        'tiebreaker = the largest such time. With cumtime enabled, participation.cumtime '
        'is the sum and the tiebreaker is the max, so both are used.',
        'Partial credit is real here: 60 + 40 ties with 50 + 50.',
    ],
    format_config=IOI_TIMED,
    contest=contest('legacy-ioi-02'),
    problems=[problem('a', 100), problem('b', 100)],
    participants=[live('alice'), live('bob'), live('carol')],
    submissions=[
        sub('alice', 'a', at(10), partial_(60)),
        sub('alice', 'b', at(30), partial_(40)),
        sub('bob', 'a', at(15), partial_(50)),
        sub('bob', 'b', at(25), partial_(50)),
        sub('carol', 'a', at(20), partial_(70)),
        sub('carol', 'b', at(20), partial_(30)),
    ],
    sensitivity={
        'submission_index': 2, 'shift_seconds': 600,
        'why': "bob's first submission moves ten minutes later, raising his cumtime "
               'and tiebreaker past alice.',
    },
)

scenario(
    'legacy_ioi/06-zero-after-accept', 'ioi', '06-zero-after-accept',
    'The same inputs as default/06-zero-after-accept, for contrast.',
    [
        'legacy_ioi selects `Min(date)` among the submissions whose points equal the '
        "participant's best on that problem, so a later worthless submission is "
        'invisible. default records the last submission time instead and would '
        'punish alice. Two formats, one input, opposite outcomes.',
    ],
    format_config=IOI_TIMED,
    contest=contest('legacy-ioi-06'),
    problems=[problem('a', 100)],
    participants=[live('alice'), live('bob')],
    submissions=[
        sub('alice', 'a', at(10), full()),
        sub('alice', 'a', at(100), zero(), result='WA'),
        sub('bob', 'a', at(90), full()),
    ],
    sensitivity={
        'submission_index': 0, 'shift_seconds': 4900,
        'why': "alice's accept moves past bob's, so her recorded time — and the "
               'first solve — change hands.',
    },
)

scenario(
    'legacy_ioi/09-best-submission-not-best-batch', 'ioi',
    '09-best-submission-not-best-batch',
    'Partial subtasks spread across two submissions. Identical inputs to '
    'ioi16/09-partial-subtasks-multiple-submissions.',
    [
        'legacy_ioi takes the best SUBMISSION: alice solves batch 1 in one '
        'submission and batch 2 in another and scores 60, not 100.',
        'ioi16 scores the same inputs 100. This pair of goldens is the whole '
        'difference between the two formats.',
    ],
    format_config=IOI_TIMED,
    contest=contest('legacy-ioi-09'),
    problems=[problem('a', 100, cases=batched_dataset(40, 60))],
    participants=[live('alice'), live('bob')],
    submissions=[
        sub('alice', 'a', at(10), batch(1, 40, 40) + batch(2, 0, 60)),
        sub('alice', 'a', at(20), batch(1, 0, 40) + batch(2, 60, 60)),
        sub('bob', 'a', at(15), batch(1, 40, 40) + batch(2, 60, 60)),
    ],
    sensitivity={
        'submission_index': 1, 'shift_seconds': -900,
        'why': "alice's better submission moves before her first one, changing the "
               'recorded time for her best score.',
    },
)

scenario(
    'legacy_ioi/12-untimed-config', 'ioi', '12-untimed-config',
    'legacy_ioi with the DEFAULT config: cumtime false, last_score_altering false.',
    [
        'With both switches off, cumtime and tiebreaker are pinned to 0 and score '
        'ties are simply never broken — the format says so explicitly.',
        'format_data STILL records the solve time even under this config; only the '
        'aggregate fields are pinned. A reimplementation that skips computing times '
        'entirely under this config would produce a different format_data.',
        'SURPRISE: first_solve is null for EVERY problem, because '
        'get_first_solves_and_total_ac guards the first-solve update on '
        '`show_time`, which is false under this config. total_ac is still counted. '
        'A reimplementation that always computes first solves will disagree here.',
        'Residual row order is decided entirely by -submission_count.',
    ],
    format_config={},
    contest=contest('legacy-ioi-12'),
    problems=[problem('a', 100)],
    participants=[live('alice'), live('bob')],
    submissions=[
        sub('alice', 'a', at(10), full()),
        sub('bob', 'a', at(20), full()),
        sub('bob', 'a', at(30), zero(), result='WA'),
    ],
    sensitivity={
        'submission_index': 0, 'shift_seconds': 7200,
        'why': "alice's accept moves two hours later; format_data.time follows it "
               'even though cumtime and the tiebreaker stay 0.',
    },
)

# =========================================================================== #
# ioi16
# =========================================================================== #
scenario(
    'ioi16/09-partial-subtasks-multiple-submissions', 'ioi16',
    '09-partial-subtasks-multiple-submissions',
    'THE scenario. Partial subtasks spread across two submissions; identical inputs '
    'to legacy_ioi/09-best-submission-not-best-batch.',
    [
        'ioi16 scores the best result PER BATCH across all submissions, summed. '
        'alice takes batch 1 from her first submission and batch 2 from her second '
        'and scores 100, where legacy_ioi gives her 60.',
        'Within one submission a batch scores min(points) over its cases; across '
        'submissions a batch scores max. ContestSubmission.points is ignored '
        'entirely — get_best_subtask_point reads SubmissionTestCase rows directly.',
        'ioi16 pins format_data time to 0 and cumtime and tiebreaker to 0 for '
        'everyone, so score ties are never broken.',
    ],
    format_config={},
    contest=contest('ioi16-09'),
    problems=[problem('a', 100, cases=batched_dataset(40, 60))],
    participants=[live('alice'), live('bob')],
    submissions=[
        sub('alice', 'a', at(10), batch(1, 40, 40) + batch(2, 0, 60)),
        sub('alice', 'a', at(20), batch(1, 0, 40) + batch(2, 60, 60)),
        sub('bob', 'a', at(15), batch(1, 40, 40) + batch(2, 60, 60)),
    ],
    sensitivity={
        'submission_index': 0, 'batch_flip': {'batch': 1, 'points': 0},
        'why': "alice's first submission loses batch 1. No other submission of hers "
               'scores that batch, so her total drops from 100 to 60 — exactly the '
               'score legacy_ioi gives her from the unperturbed input.',
    },
    null_probe={
        'submission_index': 1, 'shift_seconds': -900,
        'why': 'the second submission moves 15 minutes earlier, before the first.',
        'because': 'ioi16 records no time at all — format_data.time, cumtime and the '
                   'tiebreaker are hard-coded to 0 — so submission order and timing '
                   'cannot affect an ioi16 scoreboard.',
    },
)

scenario(
    'ioi16/10-points-scaling-factor', 'ioi16', '10-points-scaling-factor',
    'Two problems whose ContestProblem.points differ from their dataset totals, '
    'one scaling to an integer factor and one to a repeating decimal.',
    [
        'points_scaling_factor = ContestProblem.points / sum of the dataset batch '
        'points, computed from ProblemTestCase rows — NOT from the submission. '
        'Every batch score is multiplied by it before summing.',
        'Problem b scales 100/3, so the per-batch products are non-terminating and '
        'the total is rounded by contest.points_precision. Getting the rounding '
        'point wrong (per batch instead of per total) shows up here.',
        'If a problem has no dataset rows the factor divides by zero; every ioi16 '
        'problem must have ProblemTestCase rows.',
    ],
    format_config={},
    contest=contest('ioi16-10', precision=3),
    problems=[
        problem('a', 200, cases=batched_dataset(40, 60)),
        problem('b', 100, cases=batched_dataset(1, 1, 1)),
    ],
    participants=[live('alice'), live('bob')],
    submissions=[
        sub('alice', 'a', at(10), batch(1, 40, 40) + batch(2, 60, 60)),
        sub('alice', 'b', at(20), batch(1, 1, 1) + batch(2, 1, 1) + batch(3, 0, 1)),
        sub('bob', 'a', at(15), batch(1, 40, 40) + batch(2, 0, 60)),
        sub('bob', 'b', at(25), batch(1, 1, 1) + batch(2, 1, 1) + batch(3, 1, 1)),
    ],
    sensitivity={
        'submission_index': 1, 'shift_seconds': 0, 'batch_flip': {'batch': 3, 'points': 1},
        'why': "alice's third batch on b flips from 0 to 1, adding one scaled batch "
               '(100/3) to her score.',
    },
)

scenario(
    'ioi16/11-missing-batch-vs-zero-batch', 'ioi16', '11-missing-batch-vs-zero-batch',
    'A batch absent from a submission versus a batch present and scoring zero, plus '
    'a loose (unbatched) case.',
    [
        'A batch with NO test-case rows in a submission is simply absent from that '
        "submission's contribution; it does not pull the running max down to zero. "
        'A batch present with zero points contributes a zero that max() discards. '
        'The two states are distinguishable only across submissions.',
        'Cases with batch NULL are folded into batch 0 and compete with each other '
        'by min(), so all unbatched cases behave as a single implicit batch.',
        'alice reaches 100 while no single submission of hers scored more than 40.',
    ],
    format_config={},
    contest=contest('ioi16-11'),
    problems=[problem('a', 100, cases=batched_dataset(30, 60, loose=[10]))],
    participants=[live('alice'), live('bob')],
    submissions=[
        # batch 2 never ran (short circuit), so it is absent, not zero.
        sub('alice', 'a', at(10),
            [{'batch': None, 'points': 10, 'total': 10, 'status': 'AC'}] + batch(1, 30, 30)),
        sub('alice', 'a', at(20),
            [{'batch': None, 'points': 0, 'total': 10, 'status': 'WA'}]
            + batch(1, 0, 30) + batch(2, 60, 60)),
        sub('bob', 'a', at(15),
            [{'batch': None, 'points': 0, 'total': 10, 'status': 'WA'}]
            + batch(1, 0, 30) + batch(2, 60, 60)),
    ],
    sensitivity={
        'submission_index': 0, 'shift_seconds': 0, 'batch_flip': {'batch': 1, 'points': 0},
        'why': "alice's batch 1 in her first submission flips to zero; since no other "
               'submission of hers scores that batch, her total drops by 30.',
    },
)

scenario(
    'ioi16/05-virtual-participation', 'ioi16', '05-virtual-participation',
    'A virtual participation among live ones under ioi16.',
    [
        'ioi16 inherits legacy_ioi\'s first-solve code with config_defaults that '
        'contain no `last_score_altering` key and cumtime False, so `show_time` is '
        'false and first_solve is NULL for every problem — for live and virtual '
        'participants alike. total_ac still counts everyone including virtuals.',
        'Because cumtime and tiebreaker are always 0, the entire board ties and the '
        'displayed order is decided by -submission_count.',
    ],
    format_config={},
    contest=contest('ioi16-05'),
    problems=[problem('a', 100, cases=batched_dataset(40, 60))],
    participants=[live('alice'), live('bob'), virtual('mallory', 1, absolute(20, 0, 0))],
    submissions=[
        sub('alice', 'a', at(30), batch(1, 40, 40) + batch(2, 60, 60)),
        sub('bob', 'a', at(45), batch(1, 40, 40) + batch(2, 0, 60)),
        sub('bob', 'a', at(50), batch(1, 0, 40) + batch(2, 0, 60)),
        sub('bob', 'a', at(55), batch(1, 0, 40) + batch(2, 0, 60)),
        sub('mallory', 'a', absolute(20, 10, 0), batch(1, 40, 40) + batch(2, 60, 60)),
        # A second virtual submission purely so that mallory and alice differ on
        # submission_count. Without it their rows tie on every ranking key and
        # their relative order would be whatever the database happened to return.
        sub('mallory', 'a', absolute(20, 20, 0), batch(1, 0, 40) + batch(2, 0, 60)),
    ],
    sensitivity={
        'submission_index': 2, 'shift_seconds': 0, 'batch_flip': {'batch': 2, 'points': 60},
        'why': "bob's second submission gains batch 2, raising his best-per-batch "
               'total from 40 to 100 and tying him with the others.',
    },
)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = pathlib.Path(sys.argv[1])
    for spec in SCENARIOS:
        directory = root / spec['directory']
        directory.mkdir(parents=True, exist_ok=True)
        payload = {k: v for k, v in spec.items() if k != 'directory'}
        (directory / 'contest.json').write_text(
            json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('wrote', directory / 'contest.json')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

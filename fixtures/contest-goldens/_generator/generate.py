#!/usr/bin/env python3
"""Regenerate the contest-format goldens from the original DMOJ/VNOJ code.

Runs *inside* the harness container (see Containerfile and run.sh).  For every
``fixtures/contest-goldens/<format>/<scenario>/contest.json`` it

  1. flushes the database and rebuilds exactly the rows the fixture describes,
  2. calls the real ``contest.format.update_participation`` for each
     participation and the real ``get_first_solves_and_total_ac``,
  3. reproduces the ranking query and ``judge.utils.ranker`` from
     ``judge/views/contests.py``,
  4. writes a normalised ``scoreboard.json``.

Nothing in the ``online-judge`` checkout is modified; it is mounted read-only.

Normalisation (so that §6.1 "generate twice, byte-identical" holds):
  * ``format_data`` and ``first_solve`` are re-keyed from database primary keys
    to the fixture's stable problem codes / participant names.
  * floats are rounded to 9 decimal places before serialising.
  * JSON is emitted with ``sort_keys=True``, two-space indent, and a trailing
    newline.  Ordered lists (the ranking) keep their computed order.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import sys
from operator import attrgetter

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'settings_goldens')

import dmoj.compressor_patch  # noqa: F401,E402  (must precede django.setup(); mirrors manage.py)
import django  # noqa: E402

django.setup()

from django.contrib.auth.models import User  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.db.models import Count  # noqa: E402

from judge.models import (  # noqa: E402
    Contest,
    ContestParticipation,
    ContestProblem,
    ContestSubmission,
    Language,
    Problem,
    ProblemGroup,
    ProblemType,
    Profile,
    Submission,
)
from judge.models.problem_data import ProblemTestCase  # noqa: E402
from judge.models.submission import SubmissionTestCase  # noqa: E402
from judge.utils.ranker import ranker  # noqa: E402

FLOAT_PLACES = 9


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def parse_dt(value: str) -> datetime.datetime:
    """Parse an ISO-8601 instant.  A trailing ``Z`` is accepted."""
    if value.endswith('Z'):
        value = value[:-1] + '+00:00'
    dt = datetime.datetime.fromisoformat(value)
    if dt.tzinfo is None:
        raise ValueError('fixture datetimes must carry an explicit offset: %r' % value)
    return dt.astimezone(datetime.timezone.utc)


def norm(value):
    """Round floats so that a regenerated golden is byte-identical."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        rounded = round(value, FLOAT_PLACES)
        return 0.0 if rounded == 0 else rounded
    if isinstance(value, dict):
        return {k: norm(v) for k, v in value.items()}
    if isinstance(value, list):
        return [norm(v) for v in value]
    return value


def aggregate_cases(cases):
    """Reproduce the judge bridge's batch-aware case aggregation.

    judge/bridge/judge_handler.py:467-491 — loose cases sum, a batch contributes
    ``min(points)`` and ``max(total)`` over its cases.  Note ``if not case.batch``:
    batch 0 counts as *loose*, which is why fixtures number batches from 1.
    """
    points = 0.0
    total = 0.0
    batches = {}
    for case in cases:
        batch = case.get('batch')
        if not batch:
            points += float(case['points'])
            total += float(case['total'])
        elif batch in batches:
            batches[batch][0] = min(batches[batch][0], float(case['points']))
            batches[batch][1] = max(batches[batch][1], float(case['total']))
        else:
            batches[batch] = [float(case['points']), float(case['total'])]
    for batch in batches:
        points += batches[batch][0]
        total += batches[batch][1]
    return round(points, 1), round(total, 1)


def dump_json(path: pathlib.Path, payload) -> None:
    path.write_text(
        json.dumps(norm(payload), indent=2, sort_keys=True, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )


# --------------------------------------------------------------------------- #
# fixture -> database
# --------------------------------------------------------------------------- #
def reset_database() -> None:
    call_command('flush', interactive=False, verbosity=0, allow_cascade=False)


def build(fixture: dict):
    """Create every row the fixture describes.  Returns (contest, code->cp, name->part)."""
    reset_database()

    language = Language.objects.create(
        key='PY3', name='Python 3', short_name='py3', common_name='Python',
        ace='python', pygments='python', extension='py',
    )
    group = ProblemGroup.objects.create(name='goldens', full_name='Goldens')
    ptype = ProblemType.objects.create(name='goldens', full_name='Goldens')

    spec = fixture['contest']
    contest = Contest.objects.create(
        key=spec['key'],
        name=spec.get('name', spec['key']),
        description=spec.get('description', ''),
        start_time=parse_dt(spec['start_time']),
        end_time=parse_dt(spec['end_time']),
        time_limit=(
            datetime.timedelta(seconds=spec['time_limit_seconds'])
            if spec.get('time_limit_seconds') is not None else None
        ),
        format_name=fixture['format'],
        format_config=fixture.get('format_config') or None,
        points_precision=spec.get('points_precision', 3),
        frozen_last_minutes=spec.get('frozen_last_minutes', 0),
    )

    contest_problems: dict[str, ContestProblem] = {}
    for order, pspec in enumerate(fixture['problems']):
        problem = Problem.objects.create(
            code=pspec['code'],
            name=pspec.get('name', pspec['code']),
            description='',
            time_limit=1.0,
            memory_limit=65536,
            points=float(pspec['points']),
            partial=pspec.get('problem_partial', True),
            group=group,
            date=contest.start_time,
            is_public=False,
        )
        problem.types.add(ptype)
        problem.allowed_languages.add(language)
        # ProblemTestCase rows are what ContestProblem.points_scaling_factor reads.
        for case_order, cspec in enumerate(pspec.get('problem_test_cases', [])):
            ProblemTestCase.objects.create(
                dataset=problem,
                order=case_order,
                type=cspec['type'],
                points=cspec.get('points'),
                is_pretest=False,
            )
        contest_problems[pspec['code']] = ContestProblem.objects.create(
            problem=problem,
            contest=contest,
            points=pspec['points'],
            partial=pspec.get('partial', True),
            order=order,
        )

    participations: dict[str, ContestParticipation] = {}
    for uspec in fixture['participants']:
        user = User.objects.create(username=uspec['name'])
        profile = Profile.objects.get_or_create(user=user, defaults={'language': language})[0]
        profile.language = language
        profile.save()
        participations[uspec['name']] = ContestParticipation.objects.create(
            contest=contest,
            user=profile,
            real_start=parse_dt(uspec['real_start']),
            virtual=uspec.get('virtual', 0),
            is_disqualified=uspec.get('is_disqualified', False),
        )

    for sspec in fixture['submissions']:
        cases = sspec.get('cases', [])
        case_points, case_total = aggregate_cases(cases)
        contest_problem = contest_problems[sspec['problem']]
        problem = contest_problem.problem
        # Reproduces judge/bridge/judge_handler.py:493-497.
        sub_points = round(case_points / case_total * problem.points if case_total > 0 else 0, 3)
        if not problem.partial and sub_points != problem.points:
            sub_points = 0
        submission = Submission.objects.create(
            user=participations[sspec['participant']].user,
            problem=problem,
            language=language,
            status=sspec.get('status', 'D'),
            result=sspec.get('result'),
            case_points=case_points,
            case_total=case_total,
            points=sub_points,
            batch=any(c.get('batch') for c in cases),
            contest_object=contest,
        )
        # `Submission.date` is auto_now_add; the value must be forced afterwards.
        Submission.objects.filter(pk=submission.pk).update(date=parse_dt(sspec['date']))
        submission.refresh_from_db()

        for index, cspec in enumerate(cases):
            SubmissionTestCase.objects.create(
                submission=submission,
                case=index + 1,
                status=cspec.get('status', 'AC'),
                points=float(cspec['points']),
                total=float(cspec['total']),
                batch=cspec.get('batch'),
            )

        # Reproduces Submission.update_contest() (judge/models/submission.py:256).
        points = round(
            case_points / case_total * contest_problem.points if case_total > 0 else 0, 3,
        )
        partial = contest_problem.partial and contest_problem.problem.partial
        if not partial and points != contest_problem.points:
            points = 0
        ContestSubmission.objects.create(
            submission=submission,
            problem=contest_problem,
            participation=participations[sspec['participant']],
            points=points,
        )

    return contest, contest_problems, participations


# --------------------------------------------------------------------------- #
# database -> scoreboard
# --------------------------------------------------------------------------- #
def scoreboard(fixture, contest, contest_problems, participations):
    contest.refresh_from_db()
    fmt = contest.format

    # Deterministic recompute order.  update_participation() is independent per
    # participation, but fixing the order keeps any incidental state stable.
    for name in sorted(participations):
        fmt.update_participation(participations[name])

    problems = list(
        contest.contest_problems.select_related('problem').order_by('order'),
    )
    # judge/views/contests.py:base_contest_ranking_queryset
    queryset = list(
        contest.users
        .filter(virtual__gt=ContestParticipation.SPECTATE)
        .annotate(submission_count=Count('submission'))
        .order_by('is_disqualified', '-score', 'cumtime', 'tiebreaker', '-submission_count'),
    )
    first_solves, total_ac = fmt.get_first_solves_and_total_ac(problems, queryset)

    cp_code = {str(cp.id): cp.problem.code for cp in problems}
    part_name = {p.id: p.user.username for p in queryset}

    rows = []
    for rank, participation in ranker(queryset, key=attrgetter('score', 'cumtime', 'tiebreaker')):
        raw = participation.format_data or {}
        rows.append({
            'rank': rank,
            'participant': participation.user.username,
            'virtual': participation.virtual,
            'is_disqualified': participation.is_disqualified,
            'score': participation.score,
            'cumtime': participation.cumtime,
            'tiebreaker': participation.tiebreaker,
            'frozen_score': participation.frozen_score,
            'frozen_cumtime': participation.frozen_cumtime,
            'frozen_tiebreaker': participation.frozen_tiebreaker,
            'submission_count': participation.submission_count,
            'format_data': {cp_code[k]: v for k, v in raw.items() if k in cp_code},
        })

    return {
        'scenario': fixture['scenario'],
        'format': fixture['format'],
        'format_config': fixture.get('format_config'),
        'label_by_problem': {
            cp.problem.code: fmt.get_label_for_problem(index)
            for index, cp in enumerate(problems)
        },
        'problems': [
            {
                'code': cp.problem.code,
                'label': fmt.get_label_for_problem(index),
                'points': cp.points,
                'points_scaling_factor': (
                    cp.points_scaling_factor
                    if cp.problem.cases.exists() else None
                ),
                'total_ac': total_ac[str(cp.id)],
                'first_solve': part_name.get(first_solves[str(cp.id)]),
            }
            for index, cp in enumerate(problems)
        ],
        'ranking': rows,
    }


# --------------------------------------------------------------------------- #
def run_one(contest_json: pathlib.Path, out_path: pathlib.Path | None) -> dict:
    fixture = json.loads(contest_json.read_text(encoding='utf-8'))
    contest, contest_problems, participations = build(fixture)
    result = scoreboard(fixture, contest, contest_problems, participations)
    if out_path is not None:
        dump_json(out_path, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('root', help='fixtures/contest-goldens root (inside the container)')
    parser.add_argument('--only', default=None, help='<format>/<scenario> to regenerate')
    parser.add_argument(
        '--stdout', action='store_true',
        help='print the scoreboard instead of writing it (used by the sensitivity check)',
    )
    parser.add_argument(
        '--input', default=None,
        help='override the contest.json path (used by the sensitivity check)',
    )
    args = parser.parse_args()

    root = pathlib.Path(args.root)
    targets = sorted(root.glob('*/*/contest.json'))
    if args.only:
        targets = [t for t in targets if str(t.parent.relative_to(root)) == args.only]
    if not targets:
        print('no scenarios matched', file=sys.stderr)
        return 1

    for contest_json in targets:
        source = pathlib.Path(args.input) if args.input else contest_json
        if args.stdout:
            fixture = json.loads(source.read_text(encoding='utf-8'))
            contest, cps, parts = build(fixture)
            print(json.dumps(norm(scoreboard(fixture, contest, cps, parts)),
                             indent=2, sort_keys=True, ensure_ascii=False))
        else:
            fixture = json.loads(source.read_text(encoding='utf-8'))
            contest, cps, parts = build(fixture)
            dump_json(contest_json.parent / 'scoreboard.json',
                      scoreboard(fixture, contest, cps, parts))
            print('wrote', contest_json.parent.name, file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

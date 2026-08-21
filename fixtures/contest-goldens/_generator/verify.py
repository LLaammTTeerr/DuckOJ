#!/usr/bin/env python3
"""Verify the goldens and write each scenario's PROVENANCE.md.

Runs inside the harness container (``run.sh --verify``).  For every scenario:

  §6.1 reproducibility — build the scoreboard twice from the same input and
       require both to be byte-identical to the committed ``scoreboard.json``.
  §6.2 sensitivity — apply the perturbation declared in ``contest.json`` and
       record exactly which fields moved.  Every scenario must move.  A scenario
       may ALSO declare a ``null_probe``: a change that provably does *not* move
       the output, which is a finding in its own right (icpc ignores submissions
       after the accept; ioi16 records no times at all).
  §6.3 provenance — the online-judge commit, the harness image, the command and
       the date.

Exit status is non-zero if any scenario fails either check.
"""
from __future__ import annotations

import copy
import datetime
import json
import os
import pathlib
import sys

import generate  # noqa: E402  (performs django.setup())


def serialise(payload) -> str:
    return json.dumps(generate.norm(payload), indent=2, sort_keys=True, ensure_ascii=False) + '\n'


def flatten(value, prefix=''):
    out = {}
    if isinstance(value, dict):
        for key in value:
            out.update(flatten(value[key], f'{prefix}.{key}' if prefix else str(key)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            out.update(flatten(item, f'{prefix}[{index}]'))
    else:
        out[prefix] = value
    return out


def diff(before, after):
    flat_before, flat_after = flatten(before), flatten(after)
    changes = []
    for key in sorted(set(flat_before) | set(flat_after)):
        old, new = flat_before.get(key, '<absent>'), flat_after.get(key, '<absent>')
        if old != new:
            changes.append((key, old, new))
    return changes


def perturb(fixture, spec):
    perturbed = copy.deepcopy(fixture)
    submission = perturbed['submissions'][spec['submission_index']]
    if spec.get('shift_seconds'):
        moment = generate.parse_dt(submission['date'])
        moment += datetime.timedelta(seconds=spec['shift_seconds'])
        submission['date'] = moment.strftime('%Y-%m-%dT%H:%M:%SZ')
    flip = spec.get('batch_flip')
    if flip:
        matched = False
        for case in submission['cases']:
            if case.get('batch') == flip['batch']:
                case['points'] = flip['points']
                case['status'] = 'AC' if flip['points'] else 'WA'
                matched = True
        if not matched:
            raise SystemExit('batch_flip matched no case: %r' % flip)
    return perturbed


def build_scoreboard(fixture):
    contest, contest_problems, participations = generate.build(fixture)
    return generate.scoreboard(fixture, contest, contest_problems, participations)


PROVENANCE = """# Provenance — `{directory}`

{description}

## What this scenario pins down

{findings}

## How it was produced

| | |
|---|---|
| Source of truth | `online-judge` @ `{commit}` (`{commit_subject}`) |
| Harness image | `{image}` |
| Database | MariaDB 10.11 (see below) |
| Command | `fixtures/contest-goldens/_generator/run.sh --only {directory}` |
| Verified with | `fixtures/contest-goldens/_generator/run.sh --verify --only {directory}` |
| Date | {date} |

The scoreboard is produced by calling the original
`judge/contest_format/{module}.py` `update_participation()` and
`get_first_solves_and_total_ac()` against a database built from `contest.json`,
then reproducing the ranking query and `judge.utils.ranker` from
`judge/views/contests.py`. Nothing in the `online-judge` checkout is modified.

MariaDB rather than SQLite: four `judge` migrations (0085, 0089, 0189, 0198)
contain MySQL-only `UPDATE ... INNER JOIN`, so `migrate` cannot even run on
SQLite, and the ICPC format's raw SQL is MySQL-flavoured. The resolved Python
dependencies are pinned in `_generator/requirements.lock.txt`.

## Reproducibility (§6.1)

{reproducibility}

## Sensitivity (§6.2)

Perturbation: {why}

{sensitivity}
{null_probe}"""

MODULE = {'default': 'default', 'icpc': 'icpc', 'ioi': 'legacy_ioi', 'ioi16': 'ioi'}


def main() -> int:
    root = pathlib.Path(sys.argv[1])
    only = None
    if '--only' in sys.argv:
        only = sys.argv[sys.argv.index('--only') + 1]

    commit = os.environ.get('GOLDEN_OJ_COMMIT', 'unknown')
    commit_subject = os.environ.get('GOLDEN_OJ_SUBJECT', 'unknown')
    image = os.environ.get('GOLDEN_IMAGE_ID', 'unknown')
    date = os.environ.get('GOLDEN_DATE', datetime.date.today().isoformat())

    failures = []
    for contest_json in sorted(root.glob('*/*/contest.json')):
        directory = str(contest_json.parent.relative_to(root))
        if only and directory != only:
            continue
        fixture = json.loads(contest_json.read_text(encoding='utf-8'))

        first = serialise(build_scoreboard(fixture))
        second = serialise(build_scoreboard(fixture))
        committed_path = contest_json.parent / 'scoreboard.json'
        committed = committed_path.read_text(encoding='utf-8') if committed_path.exists() else ''

        repro_ok = first == second and first == committed
        if first != second:
            repro_note = '**FAILED** — two runs of the same input differ.'
        elif first != committed:
            repro_note = '**FAILED** — regeneration does not match the committed `scoreboard.json`.'
        else:
            repro_note = (
                'Generated twice and compared with the committed `scoreboard.json`: '
                'all three byte-identical.\n\n'
                'Normalised to get there: `format_data` and `first_solve` are re-keyed '
                'from database primary keys to the fixture problem codes and participant '
                'names; floats are rounded to 9 places; JSON is emitted with `sort_keys`, '
                'two-space indent and a trailing newline; `frozen_last_minutes` is 0 in '
                'every fixture so nothing depends on the wall clock.'
            )

        perturbed = serialise(build_scoreboard(perturb(fixture, fixture['sensitivity'])))
        changes = diff(json.loads(first), json.loads(perturbed))
        sens_ok = bool(changes)
        if changes:
            lines = '\n'.join(
                f'| `{key}` | `{old}` | `{new}` |' for key, old, new in changes
            )
            sens_note = (
                f'{len(changes)} field(s) changed:\n\n'
                '| field | golden | perturbed |\n|---|---|---|\n' + lines
            )
        else:
            sens_note = '**FAILED** — the output is identical under a changed input.'

        null_note = ''
        probe = fixture.get('null_probe')
        if probe:
            probe_out = serialise(build_scoreboard(perturb(fixture, probe)))
            probe_changes = diff(json.loads(first), json.loads(probe_out))
            if probe_changes:
                sens_ok = False
                null_note = (
                    '\n### Null probe — **FAILED**\n\n'
                    f'{probe["why"]} was expected to change nothing, but '
                    f'{len(probe_changes)} field(s) moved.\n'
                )
            else:
                null_note = (
                    '\n### Null probe (a change that provably does nothing)\n\n'
                    f'{probe["why"]} The scoreboard is byte-identical, because '
                    f'{probe["because"]}\n'
                )

        (contest_json.parent / 'PROVENANCE.md').write_text(
            PROVENANCE.format(
                directory=directory,
                description=fixture['description'],
                findings='\n'.join(f'- {f}' for f in fixture['findings']),
                commit=commit,
                commit_subject=commit_subject,
                image=image,
                date=date,
                module=MODULE[fixture['format']],
                reproducibility=repro_note,
                why=fixture['sensitivity']['why'],
                sensitivity=sens_note,
                null_probe=null_note,
            ),
            encoding='utf-8',
        )

        status = 'ok' if repro_ok and sens_ok else 'FAIL'
        if status == 'FAIL':
            failures.append(directory)
        print(f'{status:4} {directory:52} repro={repro_ok} sensitivity={len(changes)} fields',
              file=sys.stderr)

    if failures:
        print('FAILED: ' + ', '.join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

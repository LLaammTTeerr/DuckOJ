#!/usr/bin/env python3
"""Resolve a merge conflict in docs/DECISIONS.md (and, with --journal, the
drizzle migrations journal) deterministically, then leave them staged-ready.

The feature/bug loop merges many parallel branches that each append a `## D<n>`
block and a migration entry. The textual merge conflicts every time; the
resolution is always the same: keep BOTH sides, then sort the D-blocks by
number and re-chain the journal by `when`. Inlining this by hand failed twice
(invalid journal JSON once, a commit with conflict markers once), so it lives
here. Usage: scripts/merge-decisions.py [--journal].
"""
import re, sys, json, pathlib

def resolve_decisions(p="docs/DECISIONS.md"):
    s = pathlib.Path(p).read_text()
    s = re.sub(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n',
               lambda m: m.group(1) + '\n' + m.group(2), s, flags=re.S)
    anchor = s.index('## D16 ')
    head, body = s[:anchor], s[anchor:]
    secs = [x for x in re.split(r'(?=^## D\d+ )', body, flags=re.M) if x.strip()]
    secs.sort(key=lambda x: int(re.match(r'## D(\d+)', x).group(1)))
    out = head + ''.join(x if x.endswith('\n\n') else x.rstrip('\n') + '\n\n' for x in secs)
    pathlib.Path(p).write_text(out)
    nums = [int(re.match(r'## D(\d+)', x).group(1)) for x in secs]
    dupes = [n for n in set(nums) if nums.count(n) > 1]
    print(f"decisions: {len(secs)} blocks D{nums[0]}..D{nums[-1]}" + (f"  DUPLICATES {dupes}" if dupes else ""))

def resolve_journal(p="packages/db/migrations/meta/_journal.json"):
    txt = pathlib.Path(p).read_text()
    if '<<<<<<<' in txt:
        sys.exit("journal has raw conflict markers — resolve by picking both entries first, then re-run")
    j = json.loads(txt)
    j['entries'].sort(key=lambda e: e['idx'])
    base = j['entries'][0]['when']
    for i, e in enumerate(j['entries']):
        if i and e['when'] <= j['entries'][i-1]['when']:
            e['when'] = j['entries'][i-1]['when'] + 1000
    pathlib.Path(p).write_text(json.dumps(j, indent=2) + '\n')
    tags = [(e['idx'], e['tag']) for e in j['entries'][-3:]]
    print(f"journal: {len(j['entries'])} entries, monotonic; tail {tags}")

if __name__ == '__main__':
    resolve_decisions()
    if '--journal' in sys.argv:
        resolve_journal()

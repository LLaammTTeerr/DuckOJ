/**
 * The two things a `languageKey` decides on the submit screen: which grammar
 * highlights the buffer, and what an empty buffer is pre-filled with.
 *
 * The API's language keys are opaque identifiers minted per row of the
 * `languages` table (`cpp17` is the only one seeded today — see
 * `scripts/seed-problem.ts`), so this maps by PREFIX rather than by an
 * exhaustive table: a judge that later adds `cpp20`, `py311` or `java21`
 * highlights correctly on the day it is added, with no web deploy. An
 * unrecognised key falls back to plain text, which is the only honest
 * rendering of a grammar we do not have.
 */
export type EditorMode = 'cpp' | 'python' | 'java' | 'plain';

/**
 * C is deliberately folded into the C++ grammar. Lezer's C++ parser accepts
 * C, and a `c11` submission highlighted as C++ is right about every token a
 * C program actually contains; the alternative is no highlighting at all.
 *
 * Order matters: `java` is tested before the bare `c`/`j` prefixes could
 * ever collide, and `cs` (C#) is NOT claimed by `c` — see the guard below.
 */
export function modeForLanguage(languageKey: string): EditorMode {
  const key = languageKey.toLowerCase();
  if (key.startsWith('java')) return 'java';
  if (key.startsWith('py') || key.startsWith('python')) return 'python';
  // `cs`/`csharp` would otherwise be swallowed by the `c` prefix and get a
  // C++ grammar that is wrong about `using`, attributes and string
  // interpolation alike.
  if (key.startsWith('cs')) return 'plain';
  if (key.startsWith('c') || key.startsWith('g++') || key.startsWith('clang')) return 'cpp';
  return 'plain';
}

/**
 * The starter a pupil sees in an empty editor.
 *
 * Not a "hello world": each one is the boilerplate this judge's problems
 * actually need and that a beginner most often gets wrong — the two fast-IO
 * lines that separate `AC` from `TLE` on a large input in C++, the
 * `sys.stdin` read that does the same in Python, and the class name `Main`,
 * which is not a style preference but a hard requirement of the java driver
 * (a class named anything else does not compile against `Main.java`).
 *
 * `plain` gets nothing: inserting C++ into an editor for a language we could
 * not identify would be worse than an empty box.
 */
const TEMPLATES: Record<EditorMode, string> = {
  cpp: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    return 0;
}
`,
  python: `import sys

def main():
    data = sys.stdin.read().split()


if __name__ == "__main__":
    main()
`,
  java: `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));

    }
}
`,
  plain: '',
};

/** The starter for a language key, or `''` when there is nothing honest to insert. */
export function templateForLanguage(languageKey: string): string {
  return TEMPLATES[modeForLanguage(languageKey)];
}

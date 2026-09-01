/**
 * The two things a `languageKey` decides on the submit screen: which grammar
 * highlights the buffer, and what an empty buffer is pre-filled with.
 *
 * The API's language keys are opaque identifiers minted per row of the
 * `languages` table (seven today: migration 0042's five and 0046's `pascal`
 * and `java`), so this maps by PREFIX rather than by an exhaustive table: a
 * judge that later adds `cpp23`, `py311` or `java21` highlights correctly on
 * the day it is added, with no web deploy. An unrecognised key falls back to
 * plain text, which is the only honest rendering of a grammar we do not
 * have.
 */
export type EditorMode = 'cpp' | 'python' | 'java' | 'pascal' | 'plain';

/**
 * C is deliberately folded into the C++ grammar. Lezer's C++ parser accepts
 * C, and a `c11` submission highlighted as C++ is right about every token a
 * C program actually contains; the alternative is no highlighting at all.
 *
 * Order matters: `java` is tested before the bare `c`/`j` prefixes could
 * ever collide, and `cs` (C#) is NOT claimed by `c` — see the guard below.
 *
 * `pascal` is a mode with a TEMPLATE and no grammar, which is the one shape
 * this file did not have before F-46. The two questions in the doc comment
 * above are separate questions, and Pascal answers them differently: there is
 * no Lezer Pascal parser in the `@codemirror/lang-*` family, so the honest
 * rendering really is plain text — but a Free Pascal starter is something we
 * can be exactly right about, and `''` (what `plain` returns) would drop it.
 * `@codemirror/legacy-modes` has a StreamLanguage Pascal and is deliberately
 * NOT added: a new runtime dependency and a new bundle chunk are more than
 * highlighting one province's teaching language is worth today. See D170.
 */
export function modeForLanguage(languageKey: string): EditorMode {
  const key = languageKey.toLowerCase();
  if (key.startsWith('java')) return 'java';
  if (key.startsWith('py') || key.startsWith('python')) return 'python';
  // `cs`/`csharp` would otherwise be swallowed by the `c` prefix and get a
  // C++ grammar that is wrong about `using`, attributes and string
  // interpolation alike.
  if (key.startsWith('cs')) return 'plain';
  if (key.startsWith('pas')) return 'pascal';
  if (key.startsWith('c') || key.startsWith('g++') || key.startsWith('clang')) return 'cpp';
  return 'plain';
}

/**
 * The starter a pupil sees in an empty editor.
 *
 * Not a "hello world": each one is the boilerplate this judge's problems
 * actually need and that a beginner most often gets wrong — the two fast-IO
 * lines that separate `AC` from `TLE` on a large input in C++, the
 * `sys.stdin` read that does the same in Python, and — measured on this
 * judge's own image while sizing D169's multipliers — `{$mode objfpc}{$H+}`
 * in Pascal, without which `string` is a 255-character ShortString and a
 * `readln` of a longer line silently truncates.
 *
 * The Java starter's `Main` is a convention, NOT a driver requirement: this
 * judge's `JAVA` executor derives the class name from the source
 * (`find_class` in judge-server's `java_executor.py`) and names the file
 * after it, so any single `public class` compiles. What it does reject is a
 * `package` declaration and a non-public main class, which is why the
 * starter shows neither.
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
  pascal: `{$mode objfpc}{$H+}

var
  n: longint;

begin
  readln(n);

end.
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

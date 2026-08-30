/**
 * Which lexer a submission gets, decided from the language KEY the site
 * stores (`cpp17`, `py3`, `java17`, `c11`, …) rather than from a fixed enum.
 *
 * `languages.key` is free text in the schema — a site can add `cpp20` or
 * `pypy3` tomorrow without a migration — so a `switch` over known keys would
 * silently stop tokenising the day an administrator adds a version. Matching
 * on the shape of the key keeps a new C++ dialect working, and anything the
 * match does not recognise is reported as `null`: the caller SKIPS that
 * submission rather than comparing it with the wrong keyword table, which is
 * the difference between "we did not check this pair" and "we checked it
 * wrongly and said it was fine".
 */
export type LanguageFamily = 'c' | 'cpp' | 'python' | 'java';

/**
 * Order is load-bearing twice:
 *
 * - `javascript` and `js` are excluded BEFORE `java` is tested, or every
 *   JavaScript submission would be lexed as Java. They are near-misses of
 *   each other's names, not of each other's grammars.
 * - `cpp` is tested before the plain-`c` rule, because `cpp17` starts with a
 *   `c` and C's keyword table is a strict subset of C++'s.
 */
export function languageFamily(key: string): LanguageFamily | null {
  const k = key.toLowerCase();
  if (k.includes('javascript') || /(^|[^a-z])js([^a-z]|$)/.test(k) || k.includes('typescript')) {
    return null;
  }
  if (k.includes('cpp') || k.includes('c++') || k.includes('cxx')) return 'cpp';
  if (k.includes('java')) return 'java';
  if (k.includes('py')) return 'python';
  // `c`, `c99`, `c11`, `c17`, `gcc11`: a `c` with nothing but a standard
  // number after it. Deliberately NOT `k.includes('c')`, which would claim
  // every language whose name has a c in it — `csharp`, `scala`, `rust`'s
  // compiler keys — for a lexer that does not fit them.
  if (/^(g?cc?|c)\d*$/.test(k)) return 'c';
  return null;
}

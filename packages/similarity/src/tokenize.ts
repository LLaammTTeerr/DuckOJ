/**
 * The language-aware tokeniser the whole comparison rests on.
 *
 * What survives tokenisation IS the definition of "the same program written
 * twice". Three deliberate erasures, each aimed at a way a copy is disguised:
 *
 * - **Comments and whitespace vanish entirely.** Reformatting a file and
 *   translating its comments into another language is the cheapest disguise
 *   there is, and it must cost the copier nothing in score.
 * - **Every identifier becomes one placeholder, `V`.** Renaming `n` to
 *   `soLuong` is the second-cheapest disguise. The cost of this erasure is
 *   real and accepted: two unrelated programs that both loop over an array
 *   now look slightly more alike, which is why the threshold is 0.6 and not
 *   0.2, and why a report is a prompt to LOOK, never a verdict (D77).
 * - **Literals collapse to `N` (numbers) and `S` (strings/chars).** The
 *   CONTENT of a literal is the thing a copier changes first; that a literal
 *   was there at all is structure, so a placeholder is kept rather than the
 *   token being dropped — dropping it would make `f(1,2)` and `f(a,b)`
 *   identical after the identifier rule.
 *
 * Keywords and operators are kept verbatim, and they are the whole signal:
 * `for ( V = N ; V < V ; V ++ ) {` is a fingerprint of shape, not of naming.
 *
 * Each token carries its own `[start, end)` offsets in the ORIGINAL source,
 * because the organiser's side-by-side view has to paint the matched region
 * back onto the code a human reads — not onto the normalised stream.
 */
export interface Token {
  /** The normalised text: a keyword, an operator, or `V` / `N` / `S`. */
  readonly text: string;
  /** Offset of the first character of this token in the original source. */
  readonly start: number;
  /** Offset one past the last character, so `source.slice(start, end)` works. */
  readonly end: number;
}

import type { LanguageFamily } from './language.js';

export const IDENTIFIER = 'V';
export const NUMBER = 'N';
export const STRING = 'S';

/**
 * Keywords per family — the tokens whose identity matters.
 *
 * C's list is a subset of C++'s and is spelled out rather than derived,
 * because a shared array one family mutates is the bug this project keeps
 * finding; these are small and static.
 */
const C_KEYWORDS = [
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else',
  'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register',
  'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef',
  'union', 'unsigned', 'void', 'volatile', 'while',
];

const CPP_KEYWORDS = [
  ...C_KEYWORDS,
  'alignas', 'alignof', 'and', 'bool', 'catch', 'class', 'constexpr', 'const_cast', 'decltype',
  'delete', 'dynamic_cast', 'explicit', 'export', 'false', 'friend', 'mutable', 'namespace',
  'new', 'noexcept', 'not', 'nullptr', 'operator', 'or', 'private', 'protected', 'public',
  'reinterpret_cast', 'static_assert', 'static_cast', 'template', 'this', 'throw', 'true',
  'try', 'typeid', 'typename', 'using', 'virtual', 'wchar_t',
];

const PYTHON_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while',
  'with', 'yield',
];

const JAVA_KEYWORDS = [
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'false', 'final', 'finally',
  'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long',
  'native', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'short',
  'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'true', 'try', 'void', 'volatile', 'while',
];

const KEYWORDS: Record<LanguageFamily, ReadonlySet<string>> = {
  c: new Set(C_KEYWORDS),
  cpp: new Set(CPP_KEYWORDS),
  python: new Set(PYTHON_KEYWORDS),
  java: new Set(JAVA_KEYWORDS),
};

/**
 * Multi-character operators, longest first.
 *
 * One table for all four families rather than four: an operator a language
 * does not have simply never appears in its sources, and splitting `>>=`
 * into `>>` `=` in one family but not another would make the same C++ line
 * tokenise differently depending on which lexer read it.
 */
const OPERATORS = [
  '>>=', '<<=', '...', '->*', '<=>',
  '++', '--', '->', '::', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '//', '.*', '=>',
];

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/** Line comments and block comments, per family. */
interface CommentSyntax {
  readonly line: readonly string[];
  readonly block: readonly (readonly [string, string])[];
}

const COMMENTS: Record<LanguageFamily, CommentSyntax> = {
  c: { line: ['//'], block: [['/*', '*/']] },
  cpp: { line: ['//'], block: [['/*', '*/']] },
  java: { line: ['//'], block: [['/*', '*/']] },
  // Python has no block comment. A triple-quoted string used as a docstring
  // is handled as a STRING below and therefore collapses to `S`, which is the
  // same erasure a comment gets and the right one: a docstring is prose.
  python: { line: ['#'], block: [] },
};

/** String and character delimiters, longest first so `"""` beats `"`. */
const DELIMITERS: Record<LanguageFamily, readonly string[]> = {
  c: ['"', "'"],
  cpp: ['"', "'"],
  java: ['"""', '"', "'"],
  python: ['"""', "'''", '"', "'"],
};

/**
 * Source → normalised tokens.
 *
 * Never throws, for any input: an unterminated string or comment runs to the
 * end of the file and stops there. A tokeniser that threw would turn one
 * competitor's malformed paste into a failed run for the whole contest.
 */
export function tokenize(source: string, family: LanguageFamily): Token[] {
  const tokens: Token[] = [];
  const keywords = KEYWORDS[family];
  const comments = COMMENTS[family];
  const delimiters = DELIMITERS[family];
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    // Whitespace, including newlines: Python's indentation is significant to
    // Python and not to this comparison — two programs that differ only in
    // how they are indented are the same program.
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }

    const lineComment = comments.line.find((marker) => source.startsWith(marker, i));
    if (lineComment !== undefined) {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const blockComment = comments.block.find(([open]) => source.startsWith(open, i));
    if (blockComment) {
      const [open, close] = blockComment;
      const end = source.indexOf(close, i + open.length);
      i = end === -1 ? source.length : end + close.length;
      continue;
    }

    const delimiter = delimiters.find((quote) => source.startsWith(quote, i));
    if (delimiter !== undefined) {
      const start = i;
      i = skipString(source, i, delimiter);
      tokens.push({ text: STRING, start, end: i });
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < source.length && IDENT_PART.test(source[i]!)) i += 1;
      const word = source.slice(start, i);
      tokens.push({ text: keywords.has(word) ? word : IDENTIFIER, start, end: i });
      continue;
    }

    // `.5` is a number, `.` alone is an operator: the lookahead is what
    // separates them, and without it `x = .5` and `x = 0.5` tokenise
    // differently for no reason a reader would recognise.
    if (DIGIT.test(ch) || (ch === '.' && i + 1 < source.length && DIGIT.test(source[i + 1]!))) {
      const start = i;
      i = skipNumber(source, i);
      tokens.push({ text: NUMBER, start, end: i });
      continue;
    }

    const operator = OPERATORS.find((op) => source.startsWith(op, i));
    if (operator !== undefined) {
      tokens.push({ text: operator, start: i, end: i + operator.length });
      i += operator.length;
      continue;
    }

    // Anything else — a brace, a semicolon, a stray byte from a paste — is
    // one token of itself. Nothing is ever dropped silently.
    tokens.push({ text: ch, start: i, end: i + 1 });
    i += 1;
  }

  return tokens;
}

/**
 * Past the closing quote, or to the end of the source if there is none.
 *
 * A backslash escapes the next character, including a quote and including a
 * newline; a triple-quoted delimiter closes only on the same triple. C++ raw
 * strings (`R"d(...)d"`) are NOT modelled — the opening `R` lexes as an
 * identifier and the body as an ordinary string, so a raw string containing
 * a quote can shift the rest of that file's tokens. That is a wrong
 * fingerprint for one file, never an exception, and it degrades toward
 * "these look unrelated" rather than toward a false accusation.
 */
function skipString(source: string, start: number, quote: string): number {
  let i = start + quote.length;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source.startsWith(quote, i)) return i + quote.length;
    i += 1;
  }
  return source.length;
}

/**
 * Past a numeric literal — `42`, `0x1f`, `1e-9`, `3.14`, `1_000`, `100L`.
 *
 * Deliberately permissive: the token collapses to `N` regardless, so the only
 * thing that matters is where it ENDS. `1e-9` is one token and not three, or
 * a copier who wrote `1e-9` where the original wrote `0.000000001` would look
 * different in the operator stream as well as in the literal.
 */
function skipNumber(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (/[0-9A-Za-z_.]/.test(ch)) {
      i += 1;
      continue;
    }
    // The sign of an exponent, and only there.
    if ((ch === '+' || ch === '-') && i > start && /[eE]/.test(source[i - 1]!)) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

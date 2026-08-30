import { describe, expect, it } from 'vitest';
import { IDENTIFIER, NUMBER, STRING, languageFamily, tokenize } from '../src/index.js';

/** The normalised stream as a string, which is what every assertion here is about. */
function stream(source: string, family: Parameters<typeof tokenize>[1]): string {
  return tokenize(source, family)
    .map((token) => token.text)
    .join(' ');
}

describe('languageFamily', () => {
  it('reads the site’s own free-text keys, version and all', () => {
    expect(languageFamily('cpp17')).toBe('cpp');
    expect(languageFamily('cpp20')).toBe('cpp');
    expect(languageFamily('CXX')).toBe('cpp');
    expect(languageFamily('c11')).toBe('c');
    expect(languageFamily('c')).toBe('c');
    expect(languageFamily('py3')).toBe('python');
    expect(languageFamily('pypy3')).toBe('python');
    expect(languageFamily('java17')).toBe('java');
  });

  it('does not lex JavaScript as Java', () => {
    expect(languageFamily('javascript')).toBeNull();
    expect(languageFamily('js')).toBeNull();
    expect(languageFamily('node18')).toBeNull();
  });

  it('answers null for a language it has no lexer for', () => {
    expect(languageFamily('rust')).toBeNull();
    expect(languageFamily('pas')).toBeNull();
    expect(languageFamily('csharp')).toBeNull();
  });
});

describe('tokenize — what survives', () => {
  it('keeps keywords and operators, and normalises identifiers and literals', () => {
    expect(stream('int main() { int soLuong = 42; }', 'cpp')).toBe(
      `int ${IDENTIFIER} ( ) { int ${IDENTIFIER} = ${NUMBER} ; }`,
    );
  });

  it('erases comments entirely, in both syntaxes', () => {
    const withComments = 'int x; // đếm\n/* block\n   comment */ int y;';
    expect(stream(withComments, 'cpp')).toBe(`int ${IDENTIFIER} ; int ${IDENTIFIER} ;`);
  });

  it('erases whitespace and indentation', () => {
    expect(stream('if x:\n    return 1', 'python')).toBe(stream('if x :  return 1', 'python'));
  });

  it('collapses a string to one placeholder, keeping that a literal was there', () => {
    expect(stream('cout << "xin chao" << endl;', 'cpp')).toBe(
      `${IDENTIFIER} << ${STRING} << ${IDENTIFIER} ;`,
    );
    // A placeholder rather than nothing: `f(1)` and `f()` must not be equal.
    expect(stream('f("a")', 'cpp')).not.toBe(stream('f()', 'cpp'));
  });

  it('does not end a string on an escaped quote', () => {
    expect(stream('s = "a\\"b"; int x;', 'cpp')).toBe(
      `${IDENTIFIER} = ${STRING} ; int ${IDENTIFIER} ;`,
    );
  });

  it('treats a python docstring as one literal, not as code', () => {
    expect(stream('def f():\n  """xin chao\n  ban"""\n  return 1', 'python')).toBe(
      `def ${IDENTIFIER} ( ) : ${STRING} return ${NUMBER}`,
    );
  });

  it('reads a hash as a comment in python and as a token elsewhere', () => {
    expect(stream('x = 1 # ghi chu', 'python')).toBe(`${IDENTIFIER} = ${NUMBER}`);
    expect(stream('#include <cstdio>', 'cpp')).toBe(`# ${IDENTIFIER} < ${IDENTIFIER} >`);
  });

  it('lexes multi-character operators as one token', () => {
    expect(stream('a >>= b; c <=> d; e->f;', 'cpp')).toBe(
      `${IDENTIFIER} >>= ${IDENTIFIER} ; ${IDENTIFIER} <=> ${IDENTIFIER} ; ${IDENTIFIER} -> ${IDENTIFIER} ;`,
    );
  });

  it('lexes an exponent and a hex constant as one number each', () => {
    expect(stream('eps = 1e-9; mask = 0x1F;', 'cpp')).toBe(
      `${IDENTIFIER} = ${NUMBER} ; ${IDENTIFIER} = ${NUMBER} ;`,
    );
  });

  it('knows which keywords belong to which family', () => {
    // `class` is a keyword in C++ and an ordinary identifier in C.
    expect(stream('class x;', 'cpp')).toBe(`class ${IDENTIFIER} ;`);
    expect(stream('class x;', 'c')).toBe(`${IDENTIFIER} ${IDENTIFIER} ;`);
  });

  it('never throws on malformed input, and stops at the end of the file', () => {
    expect(() => tokenize('int x = "unterminated', 'cpp')).not.toThrow();
    expect(() => tokenize('/* unterminated', 'cpp')).not.toThrow();
    expect(() => tokenize('', 'python')).not.toThrow();
    expect(tokenize('', 'python')).toEqual([]);
  });
});

describe('tokenize — offsets', () => {
  it('points every token at its own text in the ORIGINAL source', () => {
    const source = '  int soLuong = 42;';
    for (const token of tokenize(source, 'cpp')) {
      expect(token.end).toBeGreaterThan(token.start);
      const raw = source.slice(token.start, token.end);
      // Either the token IS its own text (a keyword, an operator) or it is a
      // placeholder standing for the raw text at those offsets.
      expect(raw.length).toBeGreaterThan(0);
    }
    const tokens = tokenize(source, 'cpp');
    expect(source.slice(tokens[0]!.start, tokens[0]!.end)).toBe('int');
    expect(source.slice(tokens[1]!.start, tokens[1]!.end)).toBe('soLuong');
    expect(source.slice(tokens[3]!.start, tokens[3]!.end)).toBe('42');
  });

  it('offsets stay inside the source and never overlap', () => {
    const source = 'for (int i = 0; i < n; i++) sum += a[i];';
    const tokens = tokenize(source, 'cpp');
    let previousEnd = 0;
    for (const token of tokens) {
      expect(token.start).toBeGreaterThanOrEqual(previousEnd);
      expect(token.end).toBeLessThanOrEqual(source.length);
      previousEnd = token.end;
    }
  });
});

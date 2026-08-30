/**
 * Lowers a statement's Markdown into a Typst document for `typst compile`.
 *
 * The house rule, applied at span granularity: **translate what is known,
 * show the rest verbatim, never render something wrong.** Constructs this
 * file understands (the same family `apps/web/src/markdown.ts` renders:
 * headings, bold, italic, inline code, fenced code, lists, links, inline
 * `$...$` math) become their Typst equivalents; anything else survives as
 * escaped literal text — the worst case is a PDF showing raw Markdown
 * syntax, never dropped or misrendered content.
 *
 * Math goes through mitex (`#mi(...)`), which typesets actual LaTeX — the
 * statement's `$\frac{a}{b}$` is KaTeX-flavoured LaTeX, and hand-translating
 * LaTeX into Typst math is exactly the kind of silent-corruption rabbit
 * hole this project refuses. The mitex import is emitted ONLY when a math
 * span exists: the package is fetched from packages.typst.org on a
 * machine's first compile, and a mathless statement must not depend on the
 * network at all.
 */

/**
 * Everything Typst treats as markup in text mode.
 *
 * Exported for the results exports (D71), which build typst documents of
 * their own out of names an organiser typed and a competitor chose. One
 * escaper, not two: a second copy is a second thing to forget a character
 * from, and the character it forgets is the one that makes a document fail
 * to compile — or worse, compile into something else.
 */
export function escapeText(text: string): string {
  return text.replace(/[\\#$*_`@<>[\]{}~^'"-]/g, (ch) => `\\${ch}`);
}

/** Inside a raw block: only the fence itself needs care; content is verbatim. */
function rawBlock(code: string): string {
  // A statement containing ``` inside a fence would need a longer fence;
  // four backticks cover every fence the Markdown itself could open.
  return '````\n' + code + '\n````';
}

const MITEX_IMPORT = '#import "@preview/mitex:0.2.7": mi\n';

interface Span {
  kind: 'text' | 'code' | 'math' | 'bold' | 'italic' | 'link';
  content: string;
  href?: string;
}

/**
 * A letter or a digit, in any script — the Vietnamese corpus flanks `_`
 * with `ử` and `ề` as often as with `a`, so `\w` would be the wrong test.
 */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * CommonMark — and therefore marked, which `apps/web/src/markdown.ts`
 * renders statements with — forbids INTRAWORD `_` emphasis: in `a_{i_1}`
 * the underscores are LaTeX subscripts, not italics, and neither flank may
 * touch a word character. Without the rule the lowering both misrenders
 * that as emphasis and, worse, emits Typst emphasis delimiters glued to a
 * word, which `typst compile` rejects outright with "unclosed delimiter" —
 * it happens whenever an inline `$...$` span wraps across a source line
 * break, because the opening `$` is then left behind as literal text and
 * the LaTeX inside it reaches this tokenizer as prose.
 */
const UNDERSCORE_ITALIC = /^_([^_\n]+)_(?![\p{L}\p{N}])/u;

/** One pass, first-match-wins — the same shape marked's tokenizer imposes. */
function splitInline(line: string): Span[] {
  const spans: Span[] = [];
  let rest = line;
  const RULES: Array<{ re: RegExp; kind: Span['kind']; afterWord?: false }> = [
    { re: /^`([^`\n]+)`/, kind: 'code' },
    // A backtick is excluded from the span, not merely assumed absent from
    // it. `renderInline` emits the captured LaTeX into a typst raw literal
    // delimited by SINGLE backticks, so one backtick inside closes that
    // literal early and the rest of the document is a syntax error — and
    // `renderDocument` compiles a whole contest booklet at once, so a single
    // `$a`b$` in one statement 500s the PDF of every problem beside it. The
    // span rule is the only place that can make "backticks cannot appear in
    // inline math" true rather than hopeful; what such a span degrades to is
    // literal text, which is this file's stated worst allowed outcome.
    { re: /^\$([^$`\n]+)\$/, kind: 'math' },
    { re: /^\*\*([^*\n]+)\*\*/, kind: 'bold' },
    { re: /^\*([^*\n]+)\*/, kind: 'italic' },
    { re: UNDERSCORE_ITALIC, kind: 'italic', afterWord: false },
  ];
  const LINK = /^\[([^\]\n]+)\]\(([^)\n]+)\)/;
  outer: while (rest.length > 0) {
    const link = LINK.exec(rest);
    if (link) {
      spans.push({ kind: 'link', content: link[1]!, href: link[2]! });
      rest = rest.slice(link[0].length);
      continue;
    }
    const before = line[line.length - rest.length - 1];
    for (const rule of RULES) {
      if (rule.afterWord === false && before !== undefined && WORD_CHAR.test(before)) continue;
      const match = rule.re.exec(rest);
      if (match) {
        spans.push({ kind: rule.kind, content: match[1]! });
        rest = rest.slice(match[0].length);
        continue outer;
      }
    }
    const last = spans.at(-1);
    if (last?.kind === 'text') last.content += rest[0]!;
    else spans.push({ kind: 'text', content: rest[0]! });
    rest = rest.slice(1);
  }
  return spans;
}

function renderInline(line: string): { typst: string; usedMath: boolean } {
  let usedMath = false;
  const typst = splitInline(line)
    .map((span) => {
      switch (span.kind) {
        case 'code':
          return `\`${span.content}\``;
        case 'math':
          usedMath = true;
          // mitex wants the LaTeX in a raw literal, which is delimited by a
          // single backtick and therefore cannot contain one. The `math`
          // rule excludes backticks from the span for exactly that reason —
          // read the two together; neither is safe alone.
          return `#mi(\`${span.content}\`)`;
        case 'bold':
          // `#strong[...]` / `#emph[...]`, never the bare `*...*` / `_..._`
          // delimiters: Typst decides whether a delimiter opens or closes
          // from the characters flanking it, so emphasis emitted next to a
          // word — `x**a**y`, or any Markdown emphasis this tokenizer finds
          // mid-word — can compile to an UNCLOSED delimiter and fail the
          // whole document. The function form has no flanking rule at all.
          return `#strong[${escapeText(span.content)}]`;
        case 'italic':
          return `#emph[${escapeText(span.content)}]`;
        case 'link':
          return `#link("${span.href!.replace(/["\\]/g, '')}")[${escapeText(span.content)}]`;
        default:
          return escapeText(span.content);
      }
    })
    .join('');
  return { typst, usedMath };
}

/**
 * The body of one Markdown document, lowered. Split out of
 * `markdownToTypst` so the booklet (D48) can lower several statements into
 * ONE document without either re-implementing this loop or compiling each
 * problem separately — `usedMath` travels back out because the mitex import
 * has to be hoisted to the top of whatever document the caller assembles.
 */
function lowerBody(markdown: string): { typst: string; usedMath: boolean } {
  const lines = markdown.split('\n');
  const body: string[] = [];
  let usedMath = false;
  let fence: string[] | null = null;

  for (const line of lines) {
    if (fence !== null) {
      if (/^```/.test(line)) {
        body.push(rawBlock(fence.join('\n')));
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      fence = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const inline = renderInline(heading[2]!);
      usedMath ||= inline.usedMath;
      body.push(`${'='.repeat(heading[1]!.length + 1)} ${inline.typst}`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const inline = renderInline(bullet[1]!);
      usedMath ||= inline.usedMath;
      body.push(`- ${inline.typst}`);
      continue;
    }
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      const inline = renderInline(numbered[1]!);
      usedMath ||= inline.usedMath;
      body.push(`+ ${inline.typst}`);
      continue;
    }
    const inline = renderInline(line);
    usedMath ||= inline.usedMath;
    body.push(inline.typst);
  }
  // An unterminated fence still prints its content rather than eating it.
  if (fence !== null) body.push(rawBlock(fence.join('\n')));

  return { typst: body.join('\n'), usedMath };
}

export function markdownToTypst(name: string, markdown: string): string {
  const body = lowerBody(markdown);
  const title = renderInline(name);
  const usedMath = body.usedMath || title.usedMath;
  return (
    (usedMath ? MITEX_IMPORT : '') +
    '#set page(margin: 2cm)\n#set text(11pt)\n' +
    `= ${title.typst}\n\n` +
    body.typst +
    '\n'
  );
}

/* ------------------------------------------------------------------ D48 */

/**
 * The two languages a statement is written in (D10).
 */
export type StatementLang = 'vi' | 'en';

/**
 * The heading that splits a bilingual statement, in either direction. The
 * corpus in `content/problems/` already writes Vietnamese first and then a
 * `## English` heading, so D48 codifies that shape rather than inventing a
 * marker nothing uses; `## Tiếng Việt` is accepted for a statement drafted
 * the other way round.
 */
const SECTION_HEADINGS: ReadonlyArray<{ re: RegExp; lang: StatementLang }> = [
  { re: /^##\s+English\s*$/i, lang: 'en' },
  { re: /^##\s+Tiếng\s+Việt\s*$/i, lang: 'vi' },
];

/** A trailing thematic break — `---`, `***`, `___` — and the blank lines round it. */
const TRAILING_RULE = /\n\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * One language's half of a statement (D48).
 *
 * The split is on the FIRST top-level `## English` / `## Tiếng Việt`
 * heading: what follows it is in the language it names, what precedes it is
 * in the other one. A statement carrying no such heading is returned whole
 * for **either** language — a monolingual statement is still the statement,
 * and returning nothing would print an empty problem into a booklet.
 *
 * Fence-aware, using the same ``` tracking the lowering does: a `## English`
 * line inside a code block is sample data, not a section marker, and
 * splitting there would silently truncate the document.
 *
 * The thematic break the corpus writes above the heading is dropped from the
 * first section. `escapeText` escapes `-`, so a surviving `---` renders as
 * three literal dashes at the foot of every Vietnamese booklet page.
 */
export function statementSection(markdown: string, lang: StatementLang): string {
  const lines = markdown.split('\n');
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const marker = SECTION_HEADINGS.find((heading) => heading.re.test(line));
    if (!marker) continue;
    if (marker.lang === lang) return lines.slice(index + 1).join('\n').trim();
    return lines.slice(0, index).join('\n').replace(TRAILING_RULE, '').trim();
  }
  return markdown.trim();
}

/** One problem in the booklet, in contest order, statement already language-picked. */
export interface BookletProblem {
  /** The contest's own label — "A", "B", "1"… — printed in the heading. */
  label: string;
  name: string;
  statement: string;
  timeMs: number | null;
  memoryKb: number | null;
}

export interface BookletInput {
  name: string;
  startTime: Date;
  endTime: Date;
  lang: StatementLang;
  problems: BookletProblem[];
}

/**
 * The province is in Indochina Time, and a booklet printed for a room in
 * Vietnam dated in UTC states the wrong hour to everyone holding it. Fixed
 * rather than configurable: there is no per-deploy timezone anywhere else in
 * this codebase, and inventing one for a cover page would be the first.
 */
const BOOKLET_TZ = 'Asia/Ho_Chi_Minh';

const BOOKLET_WORDS = {
  vi: {
    heading: 'Bài',
    window: 'Thời gian thi',
    colLabel: 'Bài',
    colName: 'Tên bài',
    colTime: 'Thời gian',
    colMemory: 'Bộ nhớ',
  },
  en: {
    heading: 'Problem',
    window: 'Contest window',
    colLabel: 'Problem',
    colName: 'Title',
    colTime: 'Time',
    colMemory: 'Memory',
  },
} as const;

/** `2026-08-29 09:00` — `sv-SE` is ISO-shaped, so this needs no hand formatting. */
function formatInstant(at: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: BOOKLET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/** A cell of the cover's limits table, escaped. */
function cell(text: string): string {
  return `[${escapeText(text)}]`;
}

/**
 * The whole contest as ONE typst document (D48).
 *
 * One document, not one compile per problem and a merge: `typst compile`
 * is the expensive part, page numbering has to run across the whole booklet,
 * and concatenating PDFs would need a second dependency to do worse.
 *
 * The mitex import is hoisted here rather than emitted per statement,
 * because a typst import is only legal at the top of a document — and it is
 * still emitted only when some statement actually carries math, so a
 * mathless booklet never reaches for packages.typst.org.
 */
export function bookletToTypst(input: BookletInput): string {
  const words = BOOKLET_WORDS[input.lang];
  const bodies = input.problems.map((problem) => ({
    problem,
    title: renderInline(`${words.heading} ${problem.label}. ${problem.name}`),
    body: lowerBody(problem.statement),
  }));
  const cover = renderInline(input.name);
  const usedMath =
    cover.usedMath || bodies.some((entry) => entry.title.usedMath || entry.body.usedMath);

  const limitRows = input.problems
    .map((problem) =>
      [
        cell(problem.label),
        cell(problem.name),
        cell(problem.timeMs === null ? '—' : `${String(problem.timeMs)} ms`),
        cell(problem.memoryKb === null ? '—' : `${String(problem.memoryKb)} KB`),
      ].join(', '),
    )
    .join(',\n    ');

  const head = [
    usedMath ? MITEX_IMPORT.trimEnd() : null,
    // `numbering` on the page, not a footer of our own: every page of a
    // printed booklet has to be findable by number when a competitor asks
    // "which page is C on".
    '#set page(margin: 2cm, numbering: "1")',
    '#set text(11pt)',
    `#align(center)[#text(20pt, weight: "bold")[${cover.typst}]]`,
    `#align(center)[${escapeText(`${words.window}: ${formatInstant(input.startTime)} – ${formatInstant(input.endTime)} (GMT+7)`)}]`,
    '#v(1em)',
    '#table(',
    '  columns: 4,',
    `  ${cell(words.colLabel)}, ${cell(words.colName)}, ${cell(words.colTime)}, ${cell(words.colMemory)}${limitRows === '' ? '' : ','}`,
    limitRows === '' ? null : `    ${limitRows}`,
    ')',
  ]
    .filter((line) => line !== null)
    .join('\n');

  // The break goes BEFORE each problem, so a booklet never ends on a blank
  // page — and a contest with no problems yet is a cover page, not a cover
  // page plus an empty one.
  const sections = bodies.map(
    (entry) => `#pagebreak()\n= ${entry.title.typst}\n\n${entry.body.typst}`,
  );
  return [head, ...sections].join('\n') + '\n';
}

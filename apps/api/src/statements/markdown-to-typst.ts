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
 *
 * **Line breaks first, then the line-START markers.** The original set held
 * every character typst reads as markup MID-line and none of the four forms
 * it reads only at the START of one — `= ` (heading), `+ ` (enum item),
 * `/ ` (term list), `1. ` (numbered item) — on the reasoning that they
 * cannot be at a line start. That is true of text with no line breaks in it,
 * and `DisplayName` is `z.string().trim().min(1).max(100)`: `.trim()` is
 * ends-only, so an interior newline is a display name a competitor may set
 * for themselves. `Nguyễn Văn An\n= GIẢI NHẤT` printed a real typst HEADING
 * on their own certificate, and in the standings sheet the organiser prints
 * for everybody else — `typst query heading` returned the injected text.
 *
 * Two steps, and each is needed:
 *
 * 1. **Every line break becomes a space.** A name is a name and not a
 *    paragraph everywhere this is used, and the spans of one markdown line
 *    carry no newline, so this changes nothing about a statement. With no
 *    line breaks left, the only position that can still open markup is the
 *    first character.
 * 2. **A marker in that first position is escaped**, because the start of a
 *    content block (`#text(24pt)[…]`, a table cell) is a line start to
 *    typst. Only there: escaping `+` and `/` everywhere would put a
 *    backslash through `GMT+7` and `Hạng 3 / Rank 3` in the generated
 *    source, which renders the same but reads as noise to whoever debugs the
 *    document next.
 */
export function escapeText(text: string): string {
  const flat = text.replace(/\r\n?|\n/g, ' ');
  const escaped = flat.replace(/[\\#$*_`@<>[\]{}~^'"-]/g, (ch) => `\\${ch}`);
  // `1.` is escaped on the dot: a digit has no escape, and `\.` is a literal
  // full stop to typst.
  return escaped.replace(/^(\d+)\./, '$1\\.').replace(/^[=+/]/, (ch) => `\\${ch}`);
}

/**
 * Inside a raw block: only the fence itself needs care; content is verbatim.
 *
 * The fence must be strictly LONGER than the longest backtick run the content
 * holds — the same rule CommonMark states, and for the same reason. It used to
 * be hard-coded to four, on the reasoning that "four backticks cover every
 * fence the Markdown itself could open". That is true of what can *open* a
 * Markdown fence (a line starting with ```) and false of what can sit *inside*
 * one: nothing stops a statement author writing four backticks mid-line, and
 * when they did, the typst raw literal closed right there and the rest of the
 * line reached `typst compile` as CODE. A statement carrying
 * `#read(...)` past that point was evaluated — confirmed against the real
 * binary during the B10 security loop.
 *
 * Typst does confine reads to the project root (a `../` path is refused
 * outright), so the reach is the API's working directory rather than the host;
 * the package store lives elsewhere (`/var/lib/duckoj/packages`) and is not in
 * it. That bounds the damage, it does not make arbitrary typst evaluation
 * acceptable — and D48 compiles a contest's every problem into ONE document,
 * so one poisoned statement is the whole booklet's PDF on contest day.
 *
 * Four stays the floor, so the ordinary fenced block is unchanged.
 */
function rawBlock(code: string): string {
  const runs = code.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(4, longest + 1));
  return fence + '\n' + code + '\n' + fence;
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
  /**
   * The IANA zone to date the cover in — `users.timezone` for the reader who
   * asked (D64). `null` is D57's "not chosen", and means Indochina Time.
   */
  timeZone: string | null;
  problems: BookletProblem[];
}

/**
 * The zone a booklet falls back to (D64).
 *
 * The province is in Indochina Time, and a booklet printed for a room in
 * Vietnam dated in UTC states the wrong hour to everyone holding it. This
 * used to be THE zone, full stop; D64 makes it the default and reads
 * `users.timezone` first, on D57's rule that `NULL` means "not chosen" and
 * D18's that this judge's unchosen default is Vietnamese.
 */
const DEFAULT_BOOKLET_TZ = 'Asia/Ho_Chi_Minh';

/**
 * `Asia/Tokyo` if the reader's account says so, ICT otherwise.
 *
 * The `try` is not defensive padding. D57 deliberately accepts any
 * well-formed value into `users.timezone` — narrowing it to a list would be
 * a product ruling that breaks the moment the list grows — so `Mars/Olympus`
 * is a reachable stored value, and `Intl` THROWS on a zone it cannot
 * resolve. `booklet.pdf` is a @Public route serving a whole room at the
 * bell, so one bad row on one account must not be able to 500 it for
 * everybody. A booklet dated in the room's own clock is the harmless
 * direction to be wrong in.
 */
function resolveZone(timeZone: string | null): string {
  if (timeZone === null || timeZone === '') return DEFAULT_BOOKLET_TZ;
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_BOOKLET_TZ;
  }
}

/**
 * `GMT+7` for the zone the cover is dated in, at the instant it names.
 *
 * DERIVED, never written down. D48 printed the string `(GMT+7)` as a literal
 * beside a formatter pinned to ICT, which was true only for as long as both
 * halves stayed frozen — and the moment the zone became the reader's, a
 * hardcoded offset stops being stale and starts being a confidently wrong
 * hour on a page somebody is about to sit an exam from. Computed at the
 * contest's START, not at render time, because a zone with daylight saving
 * has two answers and the one that matters is the one in force when the room
 * sits down.
 */
function offsetLabel(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  // `longOffset` gives `GMT+07:00`; the cover has always read `GMT+7`, and a
  // whole-hour zone should not grow `:00` because this became configurable.
  return name.replace(/^GMT([+-])0?(\d+):00$/, 'GMT$1$2');
}

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
function formatInstant(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
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
  const zone = resolveZone(input.timeZone);
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
    `#align(center)[${escapeText(`${words.window}: ${formatInstant(input.startTime, zone)} – ${formatInstant(input.endTime, zone)} (${offsetLabel(input.startTime, zone)})`)}]`,
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

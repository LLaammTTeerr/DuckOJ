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

/** Everything Typst treats as markup in text mode. */
function escapeText(text: string): string {
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

/** One pass, first-match-wins — the same shape marked's tokenizer imposes. */
function splitInline(line: string): Span[] {
  const spans: Span[] = [];
  let rest = line;
  const RULES: Array<{ re: RegExp; kind: Span['kind'] }> = [
    { re: /^`([^`\n]+)`/, kind: 'code' },
    { re: /^\$([^$\n]+)\$/, kind: 'math' },
    { re: /^\*\*([^*\n]+)\*\*/, kind: 'bold' },
    { re: /^\*([^*\n]+)\*/, kind: 'italic' },
    { re: /^_([^_\n]+)_/, kind: 'italic' },
  ];
  const LINK = /^\[([^\]\n]+)\]\(([^)\n]+)\)/;
  outer: while (rest.length > 0) {
    const link = LINK.exec(rest);
    if (link) {
      spans.push({ kind: 'link', content: link[1]!, href: link[2]! });
      rest = rest.slice(link[0].length);
      continue;
    }
    for (const rule of RULES) {
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
          // mitex wants the LaTeX in a raw literal; backticks cannot appear
          // in inline math ($...$ spans exclude them by construction).
          return `#mi(\`${span.content}\`)`;
        case 'bold':
          return `*${escapeText(span.content)}*`;
        case 'italic':
          return `_${escapeText(span.content)}_`;
        case 'link':
          return `#link("${span.href!.replace(/["\\]/g, '')}")[${escapeText(span.content)}]`;
        default:
          return escapeText(span.content);
      }
    })
    .join('');
  return { typst, usedMath };
}

export function markdownToTypst(name: string, markdown: string): string {
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

  const title = renderInline(name);
  usedMath ||= title.usedMath;
  return (
    (usedMath ? MITEX_IMPORT : '') +
    '#set page(margin: 2cm)\n#set text(11pt)\n' +
    `= ${title.typst}\n\n` +
    body.join('\n') +
    '\n'
  );
}

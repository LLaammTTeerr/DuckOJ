/**
 * The `## Ví dụ` / `## Example` Markdown table convention, read as data.
 *
 * Every DuckOJ statement written before D94 carries its samples as a table in
 * the prose — first column input, second output, an optional third for the
 * explanation, cells backticked, `<br>` between lines. Two very different
 * consumers need to understand it, which is why it is a package and not a
 * file inside one of them:
 *
 *  - `apps/mcp` reads the table when it is talking to a DuckOJ deployed
 *    before D94, which sends no `samples` field at all;
 *  - `apps/web` reads it to answer a narrower question — is this table
 *    saying the same thing as the samples the API just handed me? — so that
 *    the page can render the structured samples without showing the reader
 *    the same two examples twice.
 *
 * The reader is deliberately narrow, and everything it returns says so: it
 * knows exactly one table shape and answers with nothing rather than a guess
 * for anything else. A wrong sample is worse than no sample — it sends a
 * solver hunting a bug in a correct program, and it would make the web hide a
 * table that does NOT duplicate what is being rendered.
 */

export interface Sample {
  input: string;
  output: string;
  /** The explanation column, when the table has one. */
  note?: string;
}

/** One sample table found in a statement, with the lines it occupies. */
export interface SampleTable {
  /** Index of the header row in the statement's lines. */
  start: number;
  /** Index one past the table's last row. */
  end: number;
  samples: Sample[];
}

/**
 * First-column headers that mean "input", second-column ones that mean
 * "output" — Vietnamese first, since every seeded statement is Vietnamese,
 * and the English a translated statement would use.
 */
const INPUT_HEADERS = ['dữ liệu vào', 'dữ liệu', 'input', 'đầu vào'];
const OUTPUT_HEADERS = ['kết quả', 'output', 'đầu ra', 'kết qủa'];

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * A cell is `` `2 3` `` or `` `6`<br>`1 3 2 5 4 6` `` — one backticked run per
 * LINE of the sample. Stripping the backticks and turning `<br>` into a
 * newline reconstructs the file the program would be fed. HTML entities are
 * decoded for the handful a Markdown author actually types; anything else is
 * left alone, because guessing at an entity is the same mistake as guessing
 * at a table.
 */
function cellToText(cell: string): string {
  return cell
    .split(/<br\s*\/?>/i)
    .map((line) =>
      line
        .trim()
        .replace(/^`+|`+$/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim(),
    )
    .join('\n')
    .trim();
}

function normalizeHeader(cell: string): string {
  return cell.replace(/[*_`]/g, '').trim().toLowerCase();
}

/**
 * Every sample table in the statement, in order, with the lines it occupies.
 *
 * A statement has more than one when D10's Vietnamese and English sections
 * each carry their own, which is the norm for this repo's content — so
 * nothing here may assume it has found "the" table.
 */
export function findSampleTables(statement: string): SampleTable[] {
  const lines = statement.split(/\r?\n/);
  const tables: SampleTable[] = [];

  for (let i = 0; i + 1 < lines.length; i++) {
    const header = lines[i]!;
    if (!header.includes('|')) continue;
    const headerCells = splitRow(header).map(normalizeHeader);
    if (headerCells.length < 2) continue;
    if (!INPUT_HEADERS.includes(headerCells[0]!)) continue;
    if (!OUTPUT_HEADERS.includes(headerCells[1]!)) continue;
    if (!isSeparatorRow(splitRow(lines[i + 1]!))) continue;

    const samples: Sample[] = [];
    let row = i + 2;
    for (; row < lines.length; row++) {
      const line = lines[row]!;
      if (!line.includes('|') || line.trim() === '') break;
      const cells = splitRow(line);
      const input = cellToText(cells[0] ?? '');
      const output = cellToText(cells[1] ?? '');
      // A row with no input is a formatting artefact, not a sample.
      if (input === '') continue;
      const note = cells.length > 2 ? cellToText(cells[2] ?? '') : '';
      samples.push({ input, output, ...(note === '' ? {} : { note }) });
    }
    tables.push({ start: i, end: row, samples });
  }

  return tables;
}

/**
 * Every sample the statement's tables carry, in order. `[]` when it has none
 * in the known shape — never a partial guess.
 */
export function extractSamples(statement: string): Sample[] {
  return findSampleTables(statement).flatMap((table) => table.samples);
}

/**
 * The comparison the "hide the duplicate table" rule turns on (D94).
 *
 * NOT a byte comparison, and it cannot be one: the structured sample is the
 * test FILE, which ends in a newline, while a table cell is prose a Markdown
 * author trimmed. A literal comparison would never match, and the rule would
 * be dead code that nobody noticed — so each side has its line endings
 * normalised and its trailing whitespace removed, per line and overall, and
 * nothing else is touched. Anything that still differs after that — a
 * different number of samples, a different order, an explanation on one side
 * only — means the table is saying something the rendered samples do not, and
 * the table stays.
 */
function normalize(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export function sameSamples(a: readonly Sample[], b: readonly Sample[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, i) => {
    const right = b[i]!;
    return (
      normalize(left.input) === normalize(right.input) &&
      normalize(left.output) === normalize(right.output) &&
      normalize(left.note ?? '') === normalize(right.note ?? '')
    );
  });
}

/**
 * The statement with every sample table that duplicates `samples` removed —
 * and, when removing one empties the heading above it, that heading too.
 *
 * The heading matters. The page renders the structured samples in a section
 * of its own, so a `## Ví dụ` left behind with nothing under it reads as a
 * section the statement forgot to write, which is worse than the duplication
 * this exists to remove. A heading is only dropped when the table WAS its
 * whole body: anything else in the section — a sentence about the format, a
 * second table this rule did not match — keeps it.
 *
 * A table that does not match is left exactly where it is. That is the safe
 * direction: a reader seeing the same two examples twice has lost nothing,
 * where a reader whose only copy of a third example was hidden has.
 */
export function hideDuplicateSampleTables(statement: string, samples: readonly Sample[]): string {
  if (samples.length === 0) return statement;
  const matching = findSampleTables(statement).filter((table) => sameSamples(table.samples, samples));
  if (matching.length === 0) return statement;

  const lines = statement.split('\n');
  const dropped = new Set<number>();
  for (const table of matching) {
    for (let i = table.start; i < table.end; i++) dropped.add(i);
    const heading = headingToDrop(lines, table);
    if (heading !== null) dropped.add(heading);
  }
  return lines.filter((_line, i) => !dropped.has(i)).join('\n');
}

/**
 * The index of the heading this table is the entire body of, or `null`.
 *
 * Walks up over blank lines to a `#`-heading, then down from the table to the
 * next heading (or the end); if everything between is blank, the heading has
 * nothing left to introduce.
 */
function headingToDrop(lines: readonly string[], table: SampleTable): number | null {
  let above = table.start - 1;
  while (above >= 0 && lines[above]!.trim() === '') above--;
  if (above < 0 || !/^#{1,6}\s/.test(lines[above]!)) return null;

  for (let below = table.end; below < lines.length; below++) {
    const line = lines[below]!;
    if (/^#{1,6}\s/.test(line)) break;
    // A thematic break is D10's vi/en divider, not content.
    if (line.trim() === '' || /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) continue;
    return null;
  }
  return above;
}

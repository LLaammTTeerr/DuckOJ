/**
 * Samples, pulled out of the statement, because the API does not model them.
 *
 * `GET /problems/{code}` returns `statement` as one Markdown string and there
 * is no `samples` field anywhere in `openapi.json` — the sample input and
 * output live inside the prose, as a table, and that is where the web app
 * renders them from too. An agent asked to solve a problem needs them as
 * DATA (it has to feed them to a program), so this file is the one place that
 * turns the convention back into structure.
 *
 * It is deliberately narrow, and it says so in what it returns: the extractor
 * knows exactly the shape every DuckOJ statement uses — a Markdown table
 * under a samples heading, first column input, second column output, cells
 * backticked, `<br>` between lines — and returns an empty list rather than a
 * guess for anything else. A wrong sample is worse than no sample: it sends
 * an agent hunting a bug in a correct program. The `source` field in the tool
 * output says which of the two happened, so a caller that gets none knows to
 * read the statement itself instead of concluding the problem has no samples.
 */

export interface Sample {
  input: string;
  output: string;
  /** The explanation column, when the table has one. */
  note?: string;
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
 * Every sample table in the statement, in order. Returns `[]` when the
 * statement has none in the known shape — never a partial guess.
 */
export function extractSamples(statement: string): Sample[] {
  const lines = statement.split(/\r?\n/);
  const samples: Sample[] = [];

  for (let i = 0; i + 1 < lines.length; i++) {
    const header = lines[i]!;
    if (!header.includes('|')) continue;
    const headerCells = splitRow(header).map(normalizeHeader);
    if (headerCells.length < 2) continue;
    if (!INPUT_HEADERS.includes(headerCells[0]!)) continue;
    if (!OUTPUT_HEADERS.includes(headerCells[1]!)) continue;
    if (!isSeparatorRow(splitRow(lines[i + 1]!))) continue;

    for (let row = i + 2; row < lines.length; row++) {
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
  }

  return samples;
}

/**
 * Samples scraped out of a statement — the FALLBACK path since D94.
 *
 * `GET /problems/{code}` now carries `samples` read from the published
 * revision's package (the files the judge grades against), so this file is no
 * longer how `problems_get` answers; it is how it answers a DuckOJ deployed
 * before D94, or a problem whose package the API could not read. An MCP
 * client is routinely pointed at an older server than the SDK it was built
 * against, and dropping the scraper outright would turn "your API is a
 * version behind" into "this problem has no samples" — silently, which is the
 * exact failure D94 exists to end.
 *
 * It is deliberately narrow, and it says so in what it returns: the extractor
 * knows exactly the shape every DuckOJ statement uses — a Markdown table
 * under a samples heading, first column input, second column output, cells
 * backticked, `<br>` between lines — and returns an empty list rather than a
 * guess for anything else. A wrong sample is worse than no sample: it sends
 * an agent hunting a bug in a correct program. The `source` field in the tool
 * output says which of the three happened (`api`, `statement-table`, `none`),
 * so a caller that gets none knows to read the statement itself instead of
 * concluding the problem has no samples.
 *
 * One difference from the API's samples matters and is not fixable here: a
 * table cell is trimmed prose, so these strings carry no trailing newline,
 * where `source: 'api'` hands back the sample file byte for byte.
 */

export interface Sample {
  input: string;
  output: string;
  /**
   * The setter's prose for this sample: the manifest's `explanation` when the
   * samples came from the API, the table's third column when they were
   * scraped. One key for both, so an agent does not branch on `source` to
   * read the same sentence.
   */
  note?: string;
  /** Only ever set by `source: 'api'`: the file was longer than the API inlines. */
  truncated?: boolean;
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

/** What a `problems_get` response says about where its samples came from. */
export type SampleSource = 'api' | 'statement-table' | 'none';

export interface ResolvedSamples {
  source: SampleSource;
  items: Sample[];
}

/**
 * The samples for one problem, preferring the API's over the scraper's.
 *
 * `samples` is read with `?? []` rather than as the required field the
 * contract says it is, because an MCP server is routinely pointed at a DuckOJ
 * older than the SDK it was built against — the same reason the web reads
 * `problem.editorial ?? null`. An older server sends no `samples` key at all,
 * and reading it as an array would throw on the one call every agent makes
 * first.
 *
 * An EMPTY array falls through to the scraper too, not just an absent one: a
 * package the API could not read and a problem whose tests are all scored
 * both answer `[]`, and the statement's table is the better answer than
 * nothing in either case.
 */
export function resolveSamples(problem: {
  statement: string;
  samples?: Array<{ input: string; output: string; explanation: string | null; truncated: boolean }>;
}): ResolvedSamples {
  const fromApi = problem.samples ?? [];
  if (fromApi.length > 0) {
    return {
      source: 'api',
      items: fromApi.map((sample) => ({
        input: sample.input,
        output: sample.output,
        ...(sample.explanation === null ? {} : { note: sample.explanation }),
        ...(sample.truncated ? { truncated: true } : {}),
      })),
    };
  }
  const scraped = extractSamples(problem.statement);
  return { source: scraped.length > 0 ? 'statement-table' : 'none', items: scraped };
}


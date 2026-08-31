/**
 * The seat slip — one small card per competitor, cut up and laid on the desks
 * before the bell (D129).
 *
 * Built exactly the way D71's results documents are: a typst source string,
 * `escapeText` over every piece of text a person typed, and **no clock read
 * anywhere**. The window on the card is the contest's own, so two prints of
 * the same room are the same document — which is what lets the 60 s
 * content-addressed cache (`results.cache.ts`) actually hit.
 *
 * **No password, ever.** D61 mints a school's accounts in one call and
 * returns their credentials ONCE, hashed the moment they are stored; there is
 * no re-derivable password for a slip to carry even if printing one were
 * wanted. A slip is an identity card — who you are, where you sit, when the
 * contest runs — and the credential arrives by the printable table the import
 * already produces.
 */
import { escapeText, offsetLabel, resolveZone } from './markdown-to-typst.js';

/** One card: a person, or a team and the people on it (D99). */
export interface SeatSlipRow {
  /** The competitor's display name — the TEAM's name on a team row. */
  displayName: string;
  /** Their account. On a team row this is the team's name again, so it is unused. */
  username: string;
  /** The team's members, usernames (D99); `[]` in an individual contest. */
  members: string[];
}

export interface SeatSlipsInput {
  contestName: string;
  startTime: Date;
  endTime: Date;
  /**
   * The IANA zone to print the window in — `users.timezone` for whoever asked
   * (D57/D64). `null` is D57's "not chosen", and means Indochina Time.
   *
   * The ORGANISER's zone rather than each competitor's, and unlike the
   * booklet that is not a compromise: `canRunContest` gates this route, so the
   * only caller who can reach it IS the organiser, and a stack of slips is one
   * shared artefact printed once for a room.
   */
  timeZone: string | null;
  /** `PUBLIC_ORIGIN` — where the competitor is to sign in. */
  siteUrl: string;
  rows: SeatSlipRow[];
}

const SEAT_WORDS = {
  title: 'Phiếu dự thi',
  subtitle: 'Seat slip',
  window: 'Thời gian',
  site: 'Trang thi',
  account: 'Tài khoản',
  members: 'Thành viên',
  seat: 'Phòng / Số báo danh',
} as const;

/**
 * Two columns of four — eight cards to an A4 portrait sheet.
 *
 * The height is fixed rather than `auto` on purpose: a row of cards that grew
 * with its content would put five short cards on one sheet and three tall ones
 * on the next, and a stack cut on those lines is a stack that no longer lines
 * up. 6.4 cm × 4 rows = 25.6 cm, inside the 27.7 cm an A4 page leaves after
 * 1 cm margins, with the heading's centimetre to spare — so typst breaks the
 * table after the fourth row on every page, including the first.
 */
const CARD_HEIGHT = '6.4cm';

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

/**
 * The cards' order: the display name, in Vietnamese collation.
 *
 * Not the board's order, which is what `buildResults` hands over — before the
 * gun every score is zero, so that order is whatever the database returned,
 * and a document that reorders itself between two requests hashes to two cache
 * keys and never hits. It is also simply the order a room is called in.
 */
function sortRows(rows: SeatSlipRow[]): SeatSlipRow[] {
  return [...rows].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName, 'vi') ||
      a.username.localeCompare(b.username, 'en'),
  );
}

/** One card's content block, ready to drop into a table cell. */
function card(input: SeatSlipsInput, row: SeatSlipRow, zone: string): string {
  const window = `${SEAT_WORDS.window}: ${formatInstant(input.startTime, zone)} – ${formatInstant(
    input.endTime,
    zone,
  )} (${offsetLabel(input.startTime, zone)})`;
  return [
    '  [',
    `    #text(8pt)[${escapeText(input.contestName)}]`,
    '    #linebreak()',
    `    #text(13pt, weight: "bold")[${escapeText(row.displayName)}]`,
    '    #linebreak()',
    // A team's card names its people; an individual's names their account.
    // `username` IS the team's name on a team row (D99), so an account line
    // there would print the same string twice.
    row.members.length > 0
      ? `    #text(9pt)[${escapeText(`${SEAT_WORDS.members}: ${row.members.join(' · ')}`)}]`
      : `    #text(9pt)[${escapeText(`${SEAT_WORDS.account}: ${row.username}`)}]`,
    '    #linebreak()',
    `    #text(8pt)[${escapeText(window)}]`,
    '    #linebreak()',
    `    #text(8pt)[${escapeText(`${SEAT_WORDS.site}: ${input.siteUrl}`)}]`,
    '    #v(0.6em)',
    `    #text(9pt)[${escapeText(`${SEAT_WORDS.seat}:`)}]`,
    '    #linebreak()',
    // A rule, not a run of underscores: `escapeText` escapes `_`, so a typed
    // blank prints backslashes across every card (the certificate's ruling).
    '    #line(length: 5cm)',
    '  ]',
  ].join('\n');
}

/**
 * Every competitor's card, eight to an A4 sheet, on dashed cut lines (D129).
 *
 * The stroke IS the cut guide — a dashed grey grid a pair of scissors follows
 * — so the table needs no separate rules drawn around it.
 */
export function seatsToTypst(input: SeatSlipsInput): string {
  const zone = resolveZone(input.timeZone);
  const head = [
    '#set page(paper: "a4", margin: 1cm)',
    '#set text(9pt)',
    `#align(center)[#text(14pt, weight: "bold")[${escapeText(
      `${SEAT_WORDS.title} · ${SEAT_WORDS.subtitle}`,
    )}]]`,
    '#v(0.4em)',
  ];
  // A contest nobody has entered is the heading and nothing else, never a
  // `#table(` with no cells in it (the standings sheet's own rule).
  if (input.rows.length === 0) return head.join('\n') + '\n';
  return (
    [
      ...head,
      '#table(',
      '  columns: (1fr, 1fr),',
      `  rows: ${CARD_HEIGHT},`,
      '  stroke: (paint: gray, thickness: 0.4pt, dash: "dashed"),',
      '  inset: 8pt,',
      '  align: left + top,',
      sortRows(input.rows)
        .map((row) => card(input, row, zone))
        .join(',\n') + ',',
      ')',
    ].join('\n') + '\n'
  );
}

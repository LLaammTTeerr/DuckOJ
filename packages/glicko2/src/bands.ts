/**
 * Rank titles — a placeholder band table behind one function (D6).
 *
 * The names and thresholds are deliberately Codeforces-shaped and
 * deliberately provisional: the product decision is deferred, so replacing
 * either is an edit to `RANK_BANDS` and nothing else. Two properties are
 * load-bearing and tested rather than assumed:
 *
 *   - the table is sorted ascending by `min`, and the first band's floor is
 *     `-Infinity`, so *every* number lands in exactly one band — Glicko-2
 *     has no hard lower bound, and a rating below the lowest named
 *     threshold must not fall off the table;
 *   - `min` is inclusive: a rating exactly at a boundary holds the higher
 *     title, matching how every rating site reads "1900+".
 *
 * `color` is carried for a future design pass and is NOT rendered today:
 * the approved web design reserves colour for verdicts (app.css rule 1),
 * so the UI shows the title as text only.
 */

export interface RankBand {
  /** Stable machine key — safe to persist or use in a class name. */
  key: string;
  title: string;
  /** Inclusive lower bound of the band. */
  min: number;
  /** Reserved for a future design pass; unused by the current UI. */
  color: string;
}

export const RANK_BANDS: readonly RankBand[] = [
  { key: 'newbie', title: 'Newbie', min: -Infinity, color: '#808080' },
  { key: 'pupil', title: 'Pupil', min: 1200, color: '#008000' },
  { key: 'specialist', title: 'Specialist', min: 1400, color: '#03a89e' },
  { key: 'expert', title: 'Expert', min: 1600, color: '#0000ff' },
  { key: 'candidate-master', title: 'Candidate Master', min: 1900, color: '#aa00aa' },
  { key: 'master', title: 'Master', min: 2100, color: '#ff8c00' },
  { key: 'international-master', title: 'International Master', min: 2300, color: '#ff8c00' },
  { key: 'grandmaster', title: 'Grandmaster', min: 2400, color: '#ff0000' },
  { key: 'international-grandmaster', title: 'International Grandmaster', min: 2600, color: '#ff0000' },
  { key: 'legendary-grandmaster', title: 'Legendary Grandmaster', min: 3000, color: '#ff0000' },
];

/** The band holding `rating`. Total: every finite number lands somewhere. */
export function rankBand(rating: number): RankBand {
  let held = RANK_BANDS[0]!;
  for (const band of RANK_BANDS) {
    if (rating >= band.min) held = band;
    else break;
  }
  return held;
}

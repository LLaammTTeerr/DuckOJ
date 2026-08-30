/**
 * Rank titles — the band table behind one function (D46, superseding D6's
 * placeholder).
 *
 * The names are Vietnamese olympiad/chess-flavoured, and both locales live
 * on the same row: a band's words are DATA, exactly like a tag's two
 * spellings (D18), so the UI picks a field rather than looking a key up in a
 * message catalogue. That is what keeps "rename a rank" a one-line edit here
 * instead of an edit here plus two catalogue edits that can drift apart.
 *
 * The thresholds are unchanged from the placeholder — D46 renamed the bands
 * and nothing else, so nobody's title moved for a reason they cannot see.
 * Two properties are load-bearing and tested rather than assumed:
 *
 *   - the table is sorted ascending by `min`, and the first band's floor is
 *     `-Infinity`, so *every* number lands in exactly one band — Glicko-2
 *     has no hard lower bound, and a rating below the lowest named
 *     threshold must not fall off the table;
 *   - `min` is inclusive: a rating exactly at a boundary holds the higher
 *     title, matching how every rating site reads "1900+".
 *
 * There is deliberately no `color` field any more. The web renders a band as
 * `<span class="rank {key}">`, and `app.css` owns the muted rank scale in
 * both the light and the dark palette — a hex string in this table could only
 * ever be right in one of them. The key is the class name, which is why the
 * table's test pins its shape.
 */

export interface RankBand {
  /** Stable machine key — also the CSS modifier class (`.rank.pupil`). */
  key: string;
  /** The title in Vietnamese, the default locale (D18). */
  nameVi: string;
  /** The title in English. */
  nameEn: string;
  /** Inclusive lower bound of the band. */
  min: number;
}

export const RANK_BANDS: readonly RankBand[] = [
  { key: 'newbie', nameVi: 'Tân binh', nameEn: 'Newbie', min: -Infinity },
  { key: 'pupil', nameVi: 'Học viên', nameEn: 'Pupil', min: 1200 },
  { key: 'specialist', nameVi: 'Chuyên gia', nameEn: 'Specialist', min: 1400 },
  { key: 'expert', nameVi: 'Cao thủ', nameEn: 'Expert', min: 1600 },
  {
    key: 'candidate-master',
    nameVi: 'Ứng viên kiện tướng',
    nameEn: 'Candidate Master',
    min: 1900,
  },
  { key: 'master', nameVi: 'Kiện tướng', nameEn: 'Master', min: 2100 },
  {
    key: 'international-master',
    nameVi: 'Kiện tướng quốc tế',
    nameEn: 'International Master',
    min: 2300,
  },
  { key: 'grandmaster', nameVi: 'Đại kiện tướng', nameEn: 'Grandmaster', min: 2400 },
  {
    key: 'international-grandmaster',
    nameVi: 'Đại kiện tướng quốc tế',
    nameEn: 'International Grandmaster',
    min: 2600,
  },
  {
    key: 'legendary-grandmaster',
    nameVi: 'Đại kiện tướng huyền thoại',
    nameEn: 'Legendary Grandmaster',
    min: 3000,
  },
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

import type { PackageFile } from './hash.js';

/**
 * Rejects two paths that are genuinely different strings but would collapse
 * to one file once materialised: a judge writes a package onto a filesystem
 * that may be case-insensitive (macOS, Windows) or Unicode-normalising
 * (APFS/HFS+), and `packageHash` deliberately does not fold either — see its
 * doc comment. Returns the first colliding pair found, or `null`.
 *
 * The canonical implementation of this rule — every caller that needs to
 * reject an ambiguous path list calls this, rather than keeping a private
 * copy. It lives beside the hashing and archive code because path collision
 * is a property of a package's *contents*, independent of how or when it is
 * checked (at upload, when it can inspect the archive directly; or at
 * revision-attach time, reading the same file list back out of the
 * `package_files` table for a package that was never unpacked).
 *
 * Three independent folds, not one combined fold: case-folding alone and
 * NFC-normalising alone each miss a pair that only collides once *both* are
 * applied together — e.g. `CAFÉ.txt` (NFC) against `café.txt` (NFD, a
 * lowercase 'e' plus a combining acute accent). `'CAFÉ.txt'.toLowerCase()`
 * and `'café.txt'.normalize('NFC')` are each distinct from the other string
 * alone, but `normalize('NFC').toLowerCase()` collapses both to the same
 * value — which is exactly what a default case-insensitive, Unicode
 * -normalising macOS APFS volume would do to them at write time.
 *
 * The combined fold does NOT subsume the case-alone fold, so both are still
 * needed (not merely "purely additive" on top of it): normalising *before*
 * lowercasing can compose a combining sequence into a single precomposed
 * character for one string but not the other, when only one of the two
 * differently-cased base letters has a precomposed form for that sequence.
 * `'H̱'` (H + COMBINING MACRON BELOW) and `'ẖ'` (h + the same
 * mark) are a real instance: both lowercase to the identical string
 * `'ẖ'` (case-alone collision), but only the lowercase base composes
 * under NFC — U+1E96 LATIN SMALL LETTER H WITH LINE BELOW exists, its
 * uppercase counterpart does not — so `normalize('NFC').toLowerCase()`
 * diverges: `'H̱'` stays two code points after normalising (nothing to
 * compose) and then lowercases to `'ẖ'`, while `'ẖ'` composes
 * first to the single code point `'ẖ'`, which already-lowercase then
 * leaves alone. The two combined-fold keys differ, so the byNfcLower map
 * alone would miss a pair the byLower map alone catches. (Verified by
 * exhaustive scan over every assigned Unicode code point combined with the
 * U+0300–U+036F combining-marks block — see
 * `test/collision.spec.ts`'s `'H̱'`/`'ẖ'` case.)
 */
export function findPathCollision(files: Pick<PackageFile, 'path'>[]): [string, string] | null {
  const byLower = new Map<string, string>();
  const byNfc = new Map<string, string>();
  const byNfcLower = new Map<string, string>();

  for (const file of files) {
    const lower = file.path.toLowerCase();
    const priorLower = byLower.get(lower);
    if (priorLower !== undefined) return [priorLower, file.path];
    byLower.set(lower, file.path);

    const nfc = file.path.normalize('NFC');
    const priorNfc = byNfc.get(nfc);
    if (priorNfc !== undefined) return [priorNfc, file.path];
    byNfc.set(nfc, file.path);

    const nfcLower = nfc.toLowerCase();
    const priorNfcLower = byNfcLower.get(nfcLower);
    if (priorNfcLower !== undefined) return [priorNfcLower, file.path];
    byNfcLower.set(nfcLower, file.path);
  }
  return null;
}

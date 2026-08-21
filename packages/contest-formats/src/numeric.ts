/**
 * The two numeric conversions the goldens are sensitive to.
 *
 * Both exist because the goldens were produced by CPython writing into MySQL
 * through Django, and both of those steps round differently from the obvious
 * JavaScript spelling.
 */

const DV = new DataView(new ArrayBuffer(8));

/**
 * `round(value, digits)` with CPython's semantics: round the *exact* binary
 * value of the double to `digits` decimal places, ties to even.
 *
 * `Number.prototype.toFixed` is not a substitute — it breaks ties away from
 * zero, so `(0.0625).toFixed(3)` is `"0.063"` where Python's
 * `round(0.0625, 3)` is `0.062`. `points_precision` is 3 in every golden and
 * scores are sums of scaled batch values, so a tie is reachable; getting it
 * wrong would show up as a one-ulp score difference on exactly the inputs
 * nobody thinks to write a fixture for.
 *
 * The double is decomposed to an exact `mantissa x 2^exponent` and the
 * comparison against the halfway point is done in `BigInt`, so no intermediate
 * rounding can hide a tie. Checked against CPython on 613 values across four
 * precisions (2452 pairs, 2448 identical); the one deliberate divergence is
 * `-0.0`, which this returns as `0` where Python keeps the sign. The generator's own normaliser folds `-0.0`
 * to `0.0` before writing a golden, and `toEqual` distinguishes the two, so
 * folding here is what keeps a comparison honest rather than flaky.
 */
export function pyRound(value: number, digits: number): number {
  if (!Number.isFinite(value) || value === 0) return value === 0 ? 0 : value;

  DV.setFloat64(0, value);
  const bits = DV.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const rawMantissa = bits & 0xf_ffff_ffff_ffffn;

  // value = ±mantissa * 2^exponent, exactly.
  const mantissa = rawExponent === 0 ? rawMantissa : rawMantissa | 0x10_0000_0000_0000n;
  const exponent = rawExponent === 0 ? -1074 : rawExponent - 1075;

  // |value| * 10^digits = numerator / denominator, exactly.
  let numerator = mantissa * 10n ** BigInt(digits);
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator = 1n << BigInt(-exponent);

  const quotient = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  const roundUp =
    twiceRemainder > denominator || (twiceRemainder === denominator && (quotient & 1n) === 1n);
  const scaled = roundUp ? quotient + 1n : quotient;

  // Both operands are exact doubles here, so IEEE division yields the nearest
  // double to the decimal — the same value Python's repr/strtod round-trip gives.
  const magnitude = Number(scaled) / 10 ** digits;
  return negative ? -magnitude : magnitude;
}

/**
 * Django's `IntegerField.get_prep_value` is `int(value)`, which **truncates**
 * toward zero rather than rounding. `cumtime` is a `PositiveIntegerField` fed a
 * float sum of `total_seconds()`, so this is the conversion the goldens
 * recorded — not `Math.round`.
 */
export function toIntegerField(value: number): number {
  return Math.trunc(value) + 0; // `+ 0` normalises `-0` to `0`.
}

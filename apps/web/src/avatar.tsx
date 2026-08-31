/**
 * Deterministic initials avatar — D122.
 *
 * No image, no upload, no storage. `users.avatar_key` (D9) stays unwritten
 * and unresolved; a real uploaded image remains deferred. What every person
 * on this judge gets by default is instead computed, on the client, from the
 * one string already on screen beside them — their display name, a username,
 * or a team's name. Because it is a pure function of that string it needs no
 * DTO field, no endpoint and no migration, which is the whole reason it can
 * ship where D9's avatar_key could not.
 *
 * THREE PIECES, all deterministic:
 *
 *   1. INITIALS. The first grapheme of the first name part and the first of
 *      the last part, upper-cased. A single-token name gives one letter;
 *      an empty name gives `?`. Graphemes, not code units, and NFC first, so
 *      a Vietnamese name behaves: "Trần Hưng Đạo" → "TĐ", "đỗ quyên" → "ĐQ".
 *      `Đ`/` Đ` (U+0110/U+0111) is one letter, and upper-casing it is what a
 *      Vietnamese reader expects — `toLocaleUpperCase` handles it without a
 *      locale argument, but one is accepted so a Turkish-style casing rule
 *      could never surprise a caller.
 *
 *   2. BACKGROUND. A hash of the name picks a hue; saturation and lightness
 *      are fixed at `hsl(hue 65% 25%)`. The fixed 25% lightness is not a
 *      taste call — it keeps every hue's relative luminance BELOW the band
 *      (~0.17–0.21) where neither a near-white nor a near-ink foreground can
 *      reach AA, so the foreground pick below always clears 4.5:1. The colour
 *      is a function of the name alone, so it is IDENTICAL in the light and
 *      dark themes: the initials/background pair it has to keep legible is
 *      self-contained and does not depend on the ground behind the chip.
 *
 *   3. FOREGROUND. Near-white or near-ink, whichever has the higher measured
 *      contrast against the chosen background. For the jewel-tone backgrounds
 *      this always resolves to near-white, but the pick is real and is what
 *      the 360-hue sweep test asserts stays ≥ 4.5:1 for every possible hue.
 *
 * Solid fill only — never a glass token and never `backdrop-filter`. This
 * chip renders once per scoreboard row, and D67 names a per-row backdrop
 * filter the single most expensive thing this app could ask a phone to
 * composite. A hairline `--line` border (in `app.css`) is all the depth it
 * gets, and it earns its keep separating a dark-hued chip from a dark ground.
 *
 * No motion: there is nothing to animate, so `prefers-reduced-motion` has
 * nothing to flatten.
 */
import { type CSSProperties, type ReactNode } from 'react';

/**
 * The fixed jewel-tone saturation/lightness. See the module comment for why
 * 25%. Exported so the AA sweep test measures the palette the component
 * actually ships, not a copy of the numbers — raise the lightness and the
 * test goes red.
 */
export const AVATAR_SATURATION = 65;
export const AVATAR_LIGHTNESS = 25;

/** The two foreground candidates. "Near", not pure, so text is never harsh. */
const NEAR_WHITE = '#f8fafc';
const NEAR_INK = '#111318';

/** One channel, sRGB 0–255 → linear. */
function channelToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB colour. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b)
  );
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b) + 0.05;
  const lo = Math.min(a, b) + 0.05;
  return hi / lo;
}

const NEAR_WHITE_LUMINANCE = relativeLuminance(0xf8, 0xfa, 0xfc);
const NEAR_INK_LUMINANCE = relativeLuminance(0x11, 0x13, 0x18);

/**
 * The AA foreground for a background of the given relative luminance: whichever
 * of near-white / near-ink contrasts more. Returns the chosen colour and the
 * ratio it achieves, so a test can assert the ratio directly.
 */
export function pickForeground(backgroundLuminance: number): { color: string; ratio: number } {
  const onWhite = contrastRatio(backgroundLuminance, NEAR_WHITE_LUMINANCE);
  const onInk = contrastRatio(backgroundLuminance, NEAR_INK_LUMINANCE);
  return onWhite >= onInk
    ? { color: NEAR_WHITE, ratio: onWhite }
    : { color: NEAR_INK, ratio: onInk };
}

/**
 * `hsl(h s% l%)` → rounded sRGB triple. Rounded so the value we MEASURE the
 * contrast of is byte-for-byte the value the browser paints (we emit the
 * background as `rgb()`, not `hsl()`), leaving no gap between the tested ratio
 * and the rendered one.
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lig - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * A stable hue in [0, 360) for a name. FNV-1a over the NFC-normalised,
 * trimmed, lower-cased name: normalising and lower-casing so that "An Nguyễn"
 * and "an nguyễn" — and a name however its diacritics were composed — colour
 * the same person the same way. THIS RECIPE IS PART OF D122: changing it
 * recolours every avatar in the app, so it is a decision, not a tweak.
 */
export function hueFromName(name: string): number {
  const normalised = name.normalize('NFC').trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= normalised.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/** The background (`rgb()`), the AA foreground, and the ratio, for a name. */
export function avatarColors(name: string): { background: string; color: string; ratio: number } {
  const [r, g, b] = hslToRgb(hueFromName(name), AVATAR_SATURATION, AVATAR_LIGHTNESS);
  const { color, ratio } = pickForeground(relativeLuminance(r, g, b));
  // Legacy comma syntax: it is what the CSSOM serialises back to, so the value
  // a test reads off `element.style.background` matches this string exactly.
  return { background: `rgb(${r}, ${g}, ${b})`, color, ratio };
}

/** The first grapheme of a string — a whole letter, diacritics attached. */
function firstGrapheme(text: string): string {
  if (text === '') return '';
  // `Intl.Segmenter` (Node 22, every current browser, jsdom) groups a base
  // letter with its combining marks; `Array.from` is the code-point fallback,
  // correct for the precomposed NFC letters Vietnamese uses in practice.
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of segmenter.segment(text)) return segment;
    return '';
  }
  return Array.from(text)[0] ?? '';
}

/**
 * 1–2 upper-cased initials for a name. First part + last part; a single token
 * yields one letter; nothing usable yields `?`.
 */
export function initials(name: string, locale?: string): string {
  const parts = name
    .normalize('NFC')
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
  if (parts.length === 0) return '?';
  const first = firstGrapheme(parts[0]!);
  const last = parts.length > 1 ? firstGrapheme(parts[parts.length - 1]!) : '';
  return (first + last).toLocaleUpperCase(locale);
}

/**
 * The avatar. Decorative by default — every placement in this app sits it
 * beside the very name it is drawn from, so it is `aria-hidden` and a screen
 * reader reads the name once, not twice. Pass `label` for a standalone avatar:
 * it then takes `role="img"` and that accessible name.
 */
export function Avatar({
  name,
  size = 24,
  label,
  locale,
}: {
  // Tolerant of a nullish name on purpose: a shared chip that renders once per
  // scoreboard row must never take a whole page down because one row's name is
  // missing — a nullish name falls back to `?`, exactly like an empty one.
  name: string | null | undefined;
  size?: number;
  label?: string;
  locale?: string;
}): ReactNode {
  const safeName = name ?? '';
  const { background, color } = avatarColors(safeName);
  const style: CSSProperties = {
    width: size,
    height: size,
    background,
    color,
    fontSize: Math.round(size * 0.42),
  };
  const semantics = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const);
  return (
    <span className="avatar" style={style} {...semantics}>
      {initials(safeName, locale)}
    </span>
  );
}

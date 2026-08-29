/**
 * The typed, app-facing surface over `src/vendor/qrcodegen.ts` — nothing else
 * in this app imports the vendored file, so its `@ts-nocheck` stops here.
 *
 * Exists for one screen: `/account/security` has to show an `otpauth://` URL
 * in a form an authenticator app can photograph. That has to happen
 * client-side — the secret is in the URL, and routing it through an external
 * chart/QR service would hand a third party the very thing 2FA protects.
 */
import { qrcodegen } from './vendor/qrcodegen.js';

/** The quiet zone the QR spec requires: four light modules on every side. */
const QUIET_ZONE = 4;

/**
 * `value` as a square `[row][column]` grid, `true` where the module is dark.
 *
 * Error-correction level M (~15% recoverable) rather than L: an otpauth URL is
 * short enough that M costs at most a version or two, and a phone camera
 * reading a screen at an angle is exactly the case the redundancy is for.
 */
export function qrModules(value: string): boolean[][] {
  const qr = qrcodegen.QrCode.encodeText(value, qrcodegen.QrCode.Ecc.MEDIUM);
  return Array.from({ length: qr.size }, (_row, y) =>
    Array.from({ length: qr.size }, (_col, x) => qr.getModule(x, y)),
  );
}

/**
 * One `<path>` covering every dark module — `M x y h1 v1 h-1 z` per module,
 * concatenated. Deliberately not one `<rect>` each: a version-4 code is 33×33,
 * and the elements-per-module approach puts on the order of a thousand nodes
 * into the DOM for a decorative image.
 */
function pathFor(modules: boolean[][]): string {
  const parts: string[] = [];
  for (let y = 0; y < modules.length; y++) {
    const row = modules[y]!;
    for (let x = 0; x < row.length; x++) {
      if (row[x]) parts.push(`M${String(x + QUIET_ZONE)} ${String(y + QUIET_ZONE)}h1v1h-1z`);
    }
  }
  return parts.join('');
}

/**
 * The QR image, or nothing at all.
 *
 * Rendering nothing is a deliberate, load-bearing fallback rather than an
 * error state: `encodeText` throws when the payload exceeds version 40's
 * capacity, and the enrolment screen always prints the secret as text beside
 * this. A viewer whose QR failed to draw can still type the secret in, so a
 * thrown exception here must never take the enrolment screen down with it.
 *
 * `fill="currentColor"` and an explicit white plate: a QR inverted by dark
 * mode does not scan on most readers, so the light background is painted here
 * rather than inherited, and the modules are drawn dark on top of it in both
 * themes.
 */
export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  let modules: boolean[][];
  try {
    modules = qrModules(value);
  } catch {
    return null;
  }
  const side = modules.length + 2 * QUIET_ZONE;
  return (
    <svg
      role="img"
      aria-label="QR code for the two-factor secret"
      width={size}
      height={size}
      viewBox={`0 0 ${String(side)} ${String(side)}`}
      // `crispEdges`: the module grid is axis-aligned squares, and the default
      // antialiasing smears their edges into greys at small sizes, which is
      // exactly what makes a screen-displayed code fail to scan.
      shapeRendering="crispEdges"
    >
      <rect width={side} height={side} fill="#ffffff" />
      <path d={pathFor(modules)} fill="#000000" />
    </svg>
  );
}

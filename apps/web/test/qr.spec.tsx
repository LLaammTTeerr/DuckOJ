import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QrCode, qrModules } from '../src/qr.js';

// A realistic enrolment payload: this is exactly the shape
// `POST /auth/totp/begin` answers with (`totp.keyuri(...)` in
// apps/api/src/authn/totp.service.ts).
const OTPAUTH =
  'otpauth://totp/DuckOJ:7?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=DuckOJ';

describe('qrModules', () => {
  it('produces a square matrix of a legal QR side length', () => {
    const modules = qrModules(OTPAUTH);
    expect(modules.length).toBeGreaterThan(0);
    for (const row of modules) expect(row.length).toBe(modules.length);
    // Version N is 17 + 4N modules on a side, N in 1..40.
    const version = (modules.length - 17) / 4;
    expect(Number.isInteger(version)).toBe(true);
    expect(version).toBeGreaterThanOrEqual(1);
    expect(version).toBeLessThanOrEqual(40);
  });

  it('places the three finder patterns a decoder looks for', () => {
    const m = qrModules(OTPAUTH);
    const n = m.length;
    // A finder is a 7x7 ring: dark border, light inset, 3x3 dark core. Checking
    // its corner, its inset and its centre at all three positions is enough to
    // catch a matrix that is transposed, offset, or inverted — the failure
    // modes a hand-rolled encoder actually produces.
    for (const [oy, ox] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ] as const) {
      expect(m[oy]![ox]).toBe(true); // outer ring
      expect(m[oy + 1]![ox + 1]).toBe(false); // light inset
      expect(m[oy + 3]![ox + 3]).toBe(true); // dark core
    }
    // The quiet-zone side of the top-left finder's separator is light.
    expect(m[7]![7]).toBe(false);
  });

  it('encodes different payloads differently, and the same payload stably', () => {
    const a = qrModules(OTPAUTH);
    const b = qrModules(OTPAUTH);
    const c = qrModules(`${OTPAUTH}&digits=6`);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });
});

describe('QrCode', () => {
  it('renders one labelled SVG whose viewBox covers the matrix plus a quiet zone', () => {
    render(<QrCode value={OTPAUTH} />);
    const svg = screen.getByRole('img', { name: /Mã QR/ });
    const side = qrModules(OTPAUTH).length + 2 * 4; // 4-module quiet zone per spec
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${String(side)} ${String(side)}`);
    // One path for all dark modules — not one <rect> per module, which for a
    // version-4 code is 1089 DOM nodes.
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.querySelector('path')?.getAttribute('d')).toContain('M');
  });

  it('never throws for a payload it cannot encode — the secret is the fallback', () => {
    // Well past version 40's byte capacity at any EC level.
    render(<QrCode value={'x'.repeat(10000)} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});

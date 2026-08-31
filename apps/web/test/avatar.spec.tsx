/**
 * The deterministic initials avatar — D122.
 *
 * Four things are worth a test, and each is a property the feature promises:
 * initials extraction (including Vietnamese diacritics and the empty
 * fallback), a colour that is a pure function of the name, a foreground that
 * always reaches AA against the background it is paired with — asserted for
 * EVERY hue, which turns the one-off contrast measurement into an enforced
 * invariant — and the two aria shapes (decorative vs. standalone).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_LIGHTNESS,
  AVATAR_SATURATION,
  Avatar,
  avatarColors,
  contrastRatio,
  hslToRgb,
  hueFromName,
  initials,
  pickForeground,
  relativeLuminance,
} from '../src/avatar.js';

describe('initials', () => {
  it('takes the first and last name parts of a multi-part name', () => {
    expect(initials('Nguyễn Văn A')).toBe('NA');
    expect(initials('John Smith')).toBe('JS');
    // Three parts: first and LAST, not first and second.
    expect(initials('Trần Hưng Đạo')).toBe('TĐ');
  });

  it('gives one letter for a single-token name', () => {
    expect(initials('Duck')).toBe('D');
    expect(initials('quyên')).toBe('Q');
  });

  it('upper-cases Vietnamese diacritics correctly', () => {
    // đ (U+0111) → Đ (U+0110); the whole letter survives, not a stripped ASCII d.
    expect(initials('đỗ quyên')).toBe('ĐQ');
    expect(initials('ước mơ')).toBe('ƯM');
  });

  it('collapses surrounding and interior whitespace', () => {
    expect(initials('  Lê   Lợi  ')).toBe('LL');
  });

  it('falls back to ? for an empty or blank name', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});

describe('colour', () => {
  it('is deterministic — the same name always yields the same hue and colours', () => {
    expect(hueFromName('Nguyễn Văn A')).toBe(hueFromName('Nguyễn Văn A'));
    expect(avatarColors('Nguyễn Văn A')).toEqual(avatarColors('Nguyễn Văn A'));
  });

  it('is insensitive to case and to diacritic composition', () => {
    expect(hueFromName('An Nguyễn')).toBe(hueFromName('an nguyễn'));
    // NFD (decomposed) vs NFC (composed) of the same name.
    expect(hueFromName('Đỗ'.normalize('NFD'))).toBe(hueFromName('Đỗ'.normalize('NFC')));
  });

  it('spreads different names across different hues', () => {
    const hues = new Set(
      ['An', 'Bình', 'Cường', 'Dũng', 'Em', 'Giang', 'Hà', 'Khoa'].map(hueFromName),
    );
    expect(hues.size).toBeGreaterThan(4);
  });
});

describe('foreground contrast', () => {
  it('picks the higher-contrast of near-white / near-ink', () => {
    // A near-black background wants near-white; a near-white one wants near-ink.
    expect(pickForeground(relativeLuminance(10, 10, 10)).color).toBe('#f8fafc');
    expect(pickForeground(relativeLuminance(245, 245, 245)).color).toBe('#111318');
  });

  it('reaches AA (>= 4.5:1) for EVERY hue the avatar can produce', () => {
    let worst = Infinity;
    let worstHue = -1;
    for (let hue = 0; hue < 360; hue += 1) {
      const [r, g, b] = hslToRgb(hue, AVATAR_SATURATION, AVATAR_LIGHTNESS);
      const { ratio } = pickForeground(relativeLuminance(r, g, b));
      if (ratio < worst) {
        worst = ratio;
        worstHue = hue;
      }
    }
    // The measured worst case, recorded in D122 and the report.
    expect(worst).toBeGreaterThanOrEqual(4.5);
    expect(worstHue).toBe(60);
    expect(worst).toBeCloseTo(5.52, 1);
  });

  it('the colour a real name resolves to also clears AA', () => {
    const { background, color, ratio } = avatarColors('Nguyễn Văn A');
    expect(background).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect([color, ratio >= 4.5]).toEqual([expect.any(String), true]);
  });

  it('contrastRatio is symmetric and bounded', () => {
    expect(contrastRatio(0.1, 0.5)).toBeCloseTo(contrastRatio(0.5, 0.1), 10);
    expect(contrastRatio(0, 0)).toBe(1);
  });
});

describe('aria semantics', () => {
  it('is decorative (aria-hidden) by default, so a name beside it is read once', () => {
    const { container } = render(<Avatar name="Nguyễn Văn A" />);
    const node = container.querySelector('.avatar');
    expect(node).toHaveAttribute('aria-hidden', 'true');
    expect(node).not.toHaveAttribute('role');
    expect(node).toHaveTextContent('NA');
  });

  it('is a labelled image when standalone', () => {
    render(<Avatar name="Nguyễn Văn A" label="Ảnh đại diện của Nguyễn Văn A" />);
    const node = screen.getByRole('img', { name: 'Ảnh đại diện của Nguyễn Văn A' });
    expect(node).toHaveTextContent('NA');
    expect(node).not.toHaveAttribute('aria-hidden');
  });

  it('sizes itself and paints the deterministic colour inline', () => {
    const { container } = render(<Avatar name="Duck" size={40} />);
    const node = container.querySelector<HTMLElement>('.avatar')!;
    const { background } = avatarColors('Duck');
    expect(node.style.width).toBe('40px');
    expect(node.style.height).toBe('40px');
    expect(node.style.background).toBe(background);
    // jsdom serialises the hex foreground back as `rgb(...)`, so assert it is
    // set rather than string-equal to the hex the component wrote.
    expect(node.style.color).not.toBe('');
  });
});

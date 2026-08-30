import { describe, expect, it } from 'vitest';
import { splitByLanguage } from '../src/routes/help.js';
import { en } from '../src/i18n/en.js';
import { vi } from '../src/i18n/vi.js';
import hocSinh from '../../../docs/guide/hoc-sinh.md?raw';

/**
 * The student guide opens by naming every control in the shell — both trees,
 * desktop and phone (D76). That paragraph is the one piece of prose in this
 * repository that is a LIST OF LABELS, and a label added to `nav.tsx` does
 * not add itself to it: `Tiến độ` (D83) went into both trees and into neither
 * list, so the guide told a pupil the account cluster ended at the bell and
 * their name.
 *
 * F10's own closing concern was that "nothing ties a guide sentence to the
 * screen it describes". This ties the one sentence where the tie is
 * mechanical: the labels come from the catalogues the shell renders, so a
 * renamed or added destination fails here rather than quietly making the
 * guide wrong.
 *
 * Deliberately NOT a check that the guide names ONLY these: prose is allowed
 * to say more than a list, and the failure worth catching is omission.
 */

/** Every destination the shell offers a signed-in reader, in either tree. */
const SHELL_KEYS = [
  'nav.problems',
  'nav.contests',
  'nav.submissions',
  'nav.orgs',
  'nav.help',
  'nav.api',
  'nav.admin',
  'nav.progress',
  'nav.settings',
  'nav.security',
  'nav.tokens',
  'nav.password',
  'nav.signOut',
  // The phone tree's own two controls.
  'nav.more',
  'nav.close',
] as const;

/**
 * The guide's opening description, with Markdown emphasis and line wrapping
 * flattened — `**Mã truy\ncập**` is one label to a reader and two lines to a
 * substring search.
 */
function opening(markdown: string): string {
  const body = markdown.split(/^#{2,3} \d+\./m)[0] ?? '';
  return body.replaceAll('*', '').replace(/\s+/g, ' ');
}

describe('the student guide describes the nav the shell actually renders', () => {
  const halves = splitByLanguage(hocSinh);

  it('names every Vietnamese destination', () => {
    const text = opening(halves.vi);
    for (const key of SHELL_KEYS) {
      expect(text, `the guide never names “${vi[key]}” (${key})`).toContain(vi[key]);
    }
  });

  it('names every English destination', () => {
    const text = opening(halves.en);
    for (const key of SHELL_KEYS) {
      expect(text, `the English half never names “${en[key]}” (${key})`).toContain(en[key]);
    }
  });
});

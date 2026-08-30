/**
 * `/help` — the three role guides, in the app, from the same Markdown the
 * repository ships.
 *
 * The sources are `docs/guide/*.md`, imported with Vite's `?raw` so there is
 * exactly ONE copy of each guide: a reader on the site and a reader in the
 * repository cannot be told two different things. The cost is that the
 * guides are bundled at build time — editing a guide does not reach the site
 * until the web app is rebuilt.
 *
 * Rendered through `renderStatement` (markdown.ts), the same pipeline that
 * renders problem statements, so the guides get its Markdown, its inline
 * `$...$` maths and — the load-bearing part — its DOMPurify pass before the
 * HTML reaches `dangerouslySetInnerHTML`. That pipeline also demotes `#` to
 * `<h2>`, which is why a guide may open with its own `# Title` without
 * putting a second `<h1>` on a page that already has one.
 *
 * Every guide is Vietnamese first with an English section at the end, split
 * by a top-level `## English` heading (D10's "both locales are real", and
 * the same marker D48 codified for statements and the PDF booklet). Both
 * halves are always rendered — a Vietnamese reader who wants the English
 * wording should not have to change the interface language to reach it —
 * but the reader's OWN language comes first (D18).
 *
 * This page makes no API call and holds no `<Link>`: it is readable signed
 * out, its test renders it bare, and there is nothing here for a signed-out
 * visit to 401 on.
 */
import { useState } from 'react';
import { renderStatement } from '../markdown.js';
import { useLocale, useT, type MsgKey } from '../i18n/index.js';
import hocSinh from '../../../../docs/guide/hoc-sinh.md?raw';
import giaoVien from '../../../../docs/guide/giao-vien.md?raw';
import quanTri from '../../../../docs/guide/quan-tri.md?raw';

/**
 * The language split. Anchored to a whole line so a `## English` inside a
 * sentence cannot cut a guide in half, and `m` so it matches anywhere in the
 * document rather than only at its start. The FIRST match wins — the same
 * "first top-level marker splits" rule the booklet renderer follows.
 *
 * A guide with no marker is all Vietnamese: rendering the whole thing is the
 * honest fallback, and it is what a half-translated guide should do.
 */
const ENGLISH_HEADING = /^## English[ \t]*$/m;

export function splitByLanguage(source: string): { vi: string; en: string } {
  const match = ENGLISH_HEADING.exec(source);
  if (!match) return { vi: source, en: '' };
  // The heading itself stays with the English half: it is that half's own
  // title once the two are reordered for an English reader.
  return { vi: source.slice(0, match.index), en: source.slice(match.index) };
}

interface Guide {
  readonly key: 'student' | 'teacher' | 'admin';
  readonly label: MsgKey;
  readonly source: string;
}

/** Student first: the audience with the most readers and the least context. */
const GUIDES: readonly Guide[] = [
  { key: 'student', label: 'help.tabStudent', source: hocSinh },
  { key: 'teacher', label: 'help.tabTeacher', source: giaoVien },
  { key: 'admin', label: 'help.tabAdmin', source: quanTri },
];

export function HelpPage() {
  const t = useT();
  const { locale } = useLocale();
  const [active, setActive] = useState<Guide['key']>('student');
  // `??` rather than `!`: `active` can only hold a key that exists, but the
  // page must not white-screen if that ever stops being true.
  const guide = GUIDES.find((candidate) => candidate.key === active) ?? GUIDES[0]!;
  const parts = splitByLanguage(guide.source);
  const ordered = locale === 'en' ? [parts.en, parts.vi] : [parts.vi, parts.en];
  const html = renderStatement(ordered.filter((part) => part.trim() !== '').join('\n\n'));

  return (
    <section className="panel">
      <h1>{t('help.title')}</h1>
      <p className="muted">{t('help.intro')}</p>
      {/* Buttons with `aria-pressed`, exactly like the shell's VI | EN
          toggle: three names visible at once is legible, where a single
          control cycling through roles is a guess. `role="group"` carries
          the label — a bare element's implicit role cannot be named. */}
      <p role="group" aria-label={t('help.roleGroup')}>
        {GUIDES.map((candidate) => (
          <button
            key={candidate.key}
            type="button"
            aria-pressed={candidate.key === active}
            onClick={() => setActive(candidate.key)}
          >
            {t(candidate.label)}
          </button>
        ))}
      </p>
      {/* Sanitized by `renderStatement` — see markdown.ts's module comment
          for why the DOMPurify pass runs last. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}

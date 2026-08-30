/**
 * `/help` — the three role guides rendered in the app.
 *
 * Three properties carry this file. The page must render the REAL
 * `docs/guide/*.md` (not a fixture: the whole point of the `?raw` import is
 * that the site and the repository cannot drift), it must render them as
 * HTML rather than as Markdown source, and it must put the reader's own
 * language first — a Vietnamese pupil should not have to scroll past an
 * English guide to reach theirs.
 *
 * Rendered bare, with no router and no API mock: `HelpPage` deliberately
 * holds neither a `<Link>` nor a query, which is what makes it readable
 * signed out.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

const { HelpPage, splitByLanguage } = await import('../src/routes/help.js');
const { LocaleProvider } = await import('../src/i18n/index.js');

/** A line only the Vietnamese half of each guide carries. */
const VI_TITLE = {
  student: 'Hướng dẫn cho học sinh',
  teacher: 'Hướng dẫn cho giáo viên',
  admin: 'Hướng dẫn cho quản trị viên',
};
/** A sentence only the English half of the student guide carries. */
const EN_OPENING = 'Everything you need to compete and practise on DuckOJ';

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

describe('splitByLanguage', () => {
  it('splits on a whole-line `## English` and keeps the heading with the English half', () => {
    const { vi, en } = splitByLanguage('# Xin chào\n\nMột dòng.\n\n## English\n\nHello.\n');
    expect(vi).toContain('Một dòng.');
    expect(vi).not.toContain('Hello.');
    expect(en.startsWith('## English')).toBe(true);
    expect(en).toContain('Hello.');
  });

  it('treats a guide with no marker as all Vietnamese', () => {
    const { vi, en } = splitByLanguage('# Chỉ tiếng Việt\n\nKhông có phần tiếng Anh.\n');
    expect(vi).toContain('Không có phần tiếng Anh.');
    expect(en).toBe('');
  });

  it('does not split on `## English` written inside a sentence', () => {
    const source = 'Phần ## English nằm giữa câu.\n\n## English\n\nReal split.\n';
    expect(splitByLanguage(source).en).toBe('## English\n\nReal split.\n');
  });
});

describe('HelpPage', () => {
  it('opens on the student guide, rendered from docs/guide/hoc-sinh.md', () => {
    const { container } = render(<HelpPage />);
    expect(text(container)).toContain(VI_TITLE.student);
    expect(text(container)).not.toContain(VI_TITLE.teacher);
  });

  it('switches guides, and says which one is showing', async () => {
    render(<HelpPage />);
    const group = screen.getByRole('group', { name: /Chọn bản hướng dẫn/ });
    const teacher = within(group).getByRole('button', { name: 'Giáo viên' });
    expect(within(group).getByRole('button', { name: 'Học sinh' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(teacher).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(teacher);

    expect(teacher).toHaveAttribute('aria-pressed', 'true');
    expect(document.body.textContent).toContain(VI_TITLE.teacher);
    expect(document.body.textContent).not.toContain(VI_TITLE.student);
  });

  it('reaches the administrator guide too', async () => {
    render(<HelpPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Quản trị' }));
    expect(document.body.textContent).toContain(VI_TITLE.admin);
  });

  it('shows both languages, Vietnamese first, for a Vietnamese reader', () => {
    const { container } = render(<HelpPage />);
    const body = text(container);
    expect(body).toContain(EN_OPENING);
    expect(body.indexOf(VI_TITLE.student)).toBeLessThan(body.indexOf(EN_OPENING));
  });

  it('puts the English half first once the reader has switched to English', () => {
    const { container } = render(
      <LocaleProvider initialLocale="en">
        <HelpPage />
      </LocaleProvider>,
    );
    const body = text(container);
    expect(body).toContain(VI_TITLE.student);
    expect(body.indexOf(EN_OPENING)).toBeLessThan(body.indexOf(VI_TITLE.student));
  });

  it('renders the Markdown as HTML, not as source', () => {
    const { container } = render(<HelpPage />);
    // A real list and a real table, and no leftover `##` from a heading.
    expect(container.querySelector('ul li')).not.toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
    expect(text(container)).not.toContain('## English');
  });

  it('keeps one `<h1>` on the page — the guides own headings are demoted', () => {
    const { container } = render(<HelpPage />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hướng dẫn sử dụng');
    // The guide's own `# Hướng dẫn cho học sinh` becomes an `<h2>`.
    expect(screen.getByRole('heading', { level: 2, name: VI_TITLE.student })).toBeInTheDocument();
  });
});

/**
 * m23 — the submit page never said which contest it was submitting into.
 *
 * `contestKey` is what decides whether a `contest_submissions` row is written
 * at all (4d's explicit-key design), and it is threaded silently from the
 * router. A submission that quietly went to practice cannot be recovered: the
 * window closes and it never counted. This is the one screen where that choice
 * is actually made, so it has to say which one it made.
 */
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const get = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: React.ReactNode; params?: { key?: string } }) => (
    <a href={`/contests/${params?.key ?? ''}`}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

const { SubmitPage } = await import('../src/routes/submit.js');

function wrap(ui: ReactElement) {
  return render(ui);
}

describe('SubmitPage', () => {
  it('names the contest it is submitting into, as a link', () => {
    wrap(<SubmitPage problemCode="aplusb" contestKey="spring" />);

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Nộp vào kỳ thi');
    expect(screen.getByRole('link', { name: 'spring' })).toHaveAttribute(
      'href',
      '/contests/spring',
    );
  });

  it('says plainly that a keyless submission is practice', () => {
    wrap(<SubmitPage problemCode="aplusb" />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/luyện tập/i)).toBeInTheDocument();
  });
});

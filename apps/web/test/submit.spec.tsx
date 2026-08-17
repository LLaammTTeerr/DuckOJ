import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SubmitForm, VerdictPanel } from '../src/routes/submit.js';

describe('SubmitForm', () => {
  it('submits the entered source and language', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<SubmitForm onSubmit={onSubmit} languages={['cpp17']} busy={false} />);

    // userEvent.type() parses `{...}` as its key-descriptor DSL, and C++
    // source is full of literal braces — every future test that types code
    // through this field hits the same wall. Paste sidesteps the DSL
    // entirely (and is closer to what a user actually does with code), so
    // don't "simplify" this back to .type().
    await userEvent.click(screen.getByLabelText(/source/i));
    await userEvent.paste('int main(){}');
    await userEvent.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith({ languageKey: 'cpp17', source: 'int main(){}' });
  });

  it('disables the button while a submission is in flight', () => {
    render(<SubmitForm onSubmit={vi.fn()} languages={['cpp17']} busy />);
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });
});

describe('VerdictPanel', () => {
  it('shows the running state before a verdict exists', () => {
    render(<VerdictPanel submission={{ state: 'compiling', verdict: null, cases: [] } as never} />);
    expect(screen.getByText(/compiling/i)).toBeInTheDocument();
  });

  it('shows the verdict and each case once grading finishes', () => {
    render(
      <VerdictPanel
        submission={
          {
            state: 'done',
            verdict: 'WA',
            points: 1,
            maxPoints: 3,
            cases: [
              { groupIndex: 0, caseIndex: 0, verdict: 'AC', skipped: false, timeMs: 4, memoryKb: 900 },
              { groupIndex: 0, caseIndex: 1, verdict: 'WA', skipped: false, timeMs: 5, memoryKb: 900 },
              { groupIndex: 0, caseIndex: 2, verdict: null, skipped: true, timeMs: 0, memoryKb: 0 },
            ],
          } as never
        }
      />,
    );

    expect(screen.getByText('WA', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    // A skipped case never ran, so it must not display a verdict of its own.
    expect(screen.getByText(/skipped/i)).toBeInTheDocument();
  });
});

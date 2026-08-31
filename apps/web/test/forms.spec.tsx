/**
 * The shared form furniture: the server's 422 `fields` mapped onto this app's
 * own inputs (D146), the Focusable Error Summary D110 built once on
 * `/register` and never reused, and the guard that stops a route change or a
 * closed tab from eating a half-written contest (D147).
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { blocker } = vi.hoisted(() => ({ blocker: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: (...args: unknown[]) => blocker(...args) as unknown,
}));

const { ApiError } = await import('../src/api-error.js');
const { ErrorSummary, mapFieldErrors, useDirtyGuard } = await import('../src/forms.js');

describe('mapFieldErrors', () => {
  it('routes a server 422 field onto the input this form calls it', () => {
    const errors = mapFieldErrors(
      { startTime: ['Required'], name: ['Too short'] },
      { startTime: 'start', name: 'name' },
    );
    expect(errors).toEqual({ start: 'Required', name: 'Too short' });
  });

  it('reads an indexed path through a wildcard, so row 7 lands on the rows field', () => {
    const errors = mapFieldErrors(
      { 'problems.7.points': ['Expected number'] },
      { 'problems.*.points': 'rows' },
    );
    expect(errors).toEqual({ rows: 'Expected number' });
  });

  it('joins several objections about one field rather than showing only the last', () => {
    const errors = mapFieldErrors({ key: ['Too short', 'Bad characters'] }, { key: 'key' });
    expect(errors.key).toContain('Too short');
    expect(errors.key).toContain('Bad characters');
  });

  it('drops a path this form has no input for, so nothing is attributed by guess', () => {
    expect(mapFieldErrors({ pointsPrecision: ['nope'] }, { name: 'name' })).toEqual({});
    expect(mapFieldErrors(undefined, { name: 'name' })).toEqual({});
  });

  it('takes the fields straight off an ApiError', () => {
    const error = new ApiError(422, 'no', 'validation_failed', 'no', { name: ['Too short'] });
    expect(mapFieldErrors(error.fields, { name: 'name' })).toEqual({ name: 'Too short' });
  });
});

describe('ErrorSummary', () => {
  function Harness(props: { errors: Record<string, string>; attempt: number }) {
    return (
      <>
        <input id="alpha" aria-label="Alpha" />
        <ErrorSummary errors={props.errors} order={['alpha', 'beta']} attempt={props.attempt} />
      </>
    );
  }

  it('is silent while the form is clean', () => {
    render(<Harness errors={{}} attempt={0} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces, takes focus, and links each bad field in screen order', async () => {
    render(<Harness errors={{ beta: 'Beta is wrong', alpha: 'Alpha is wrong' }} attempt={1} />);
    const summary = screen.getByRole('alert');
    await waitFor(() => expect(summary).toHaveFocus());
    const links = within(summary).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Alpha is wrong', 'Beta is wrong']);

    // jsdom does not act on a hash href, so the click handler is what carries
    // a keyboard reader to the field — D110's own note.
    await userEvent.click(links[0]!);
    expect(screen.getByLabelText('Alpha')).toHaveFocus();
  });

  it('re-takes focus on a SECOND failed submit with the identical errors', async () => {
    const errors = { alpha: 'Alpha is wrong' };
    const view = render(<Harness errors={errors} attempt={1} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    act(() => {
      screen.getByLabelText('Alpha').focus();
    });

    view.rerender(<Harness errors={errors} attempt={2} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  });
});

describe('useDirtyGuard', () => {
  function Harness(props: { dirty: boolean }) {
    const release = useDirtyGuard(props.dirty);
    return (
      <button type="button" onClick={release}>
        release
      </button>
    );
  }

  function unload(): Event {
    const event = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  }

  it('lets the page unload while nothing has been typed', () => {
    render(<Harness dirty={false} />);
    expect(unload().defaultPrevented).toBe(false);
  });

  it('stops the tab from closing over unsaved work', () => {
    render(<Harness dirty />);
    expect(unload().defaultPrevented).toBe(true);
  });

  it('stops guarding once the work is saved, and after unmount', () => {
    function Toggle() {
      const [dirty, setDirty] = useState(true);
      return (
        <>
          <Harness dirty={dirty} />
          <button type="button" onClick={() => setDirty(false)}>
            saved
          </button>
        </>
      );
    }
    const view = render(<Toggle />);
    act(() => {
      screen.getByRole('button', { name: 'saved' }).click();
    });
    expect(unload().defaultPrevented).toBe(false);

    view.unmount();
    expect(unload().defaultPrevented).toBe(false);
  });

  it('blocks a router navigation when the reader declines to leave', () => {
    blocker.mockClear();
    render(<Harness dirty />);
    const opts = blocker.mock.calls.at(-1)![0] as {
      shouldBlockFn: () => boolean;
      disabled: boolean;
    };
    expect(opts.disabled).toBe(false);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(opts.shouldBlockFn()).toBe(true);
    // …and lets them through when they say yes, so the guard is a question
    // and not a cage.
    confirm.mockReturnValue(true);
    expect(opts.shouldBlockFn()).toBe(false);
    confirm.mockRestore();
  });

  it('a save that navigates on success is not blocked by its own guard', () => {
    blocker.mockClear();
    render(<Harness dirty />);
    const opts = blocker.mock.calls.at(-1)![0] as { shouldBlockFn: () => boolean };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(opts.shouldBlockFn()).toBe(true);

    // `release()` is what the save handler calls in the tick before
    // `navigate()`; React has not re-rendered yet, so only a ref can answer.
    act(() => {
      screen.getByRole('button', { name: 'release' }).click();
    });
    expect(opts.shouldBlockFn()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('leaves the router alone while the form is clean', () => {
    blocker.mockClear();
    render(<Harness dirty={false} />);
    const opts = blocker.mock.calls.at(-1)![0] as { disabled: boolean };
    expect(opts.disabled).toBe(true);
  });
});

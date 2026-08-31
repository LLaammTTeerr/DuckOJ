/**
 * The furniture every form on this site needs and only `/register` had.
 *
 * Three separate problems, one module, because all three are about the same
 * moment: somebody pressed the button and it did not work.
 *
 *  - **D146.** The API attributes a validation failure field by field —
 *    `ZodValidationPipe` turns every issue's `path` into
 *    `fields: { "startTime": ["Required"] }` on the 422 — and until this file
 *    the browser threw all of it away. Every form showed the same English
 *    sentence the pipe writes for the banner ("The request body failed
 *    validation."), beside no field at all, in a Vietnamese page. The
 *    objections were always on the wire; nothing read them.
 *  - **D110, reused.** The Focusable Error Summary was built for the register
 *    form and stayed there. It is a component now.
 *  - **D147.** Nothing in this app ever asked "you have unsaved work" —
 *    `grep beforeunload src/` was empty. A setter three paragraphs into a
 *    statement who clicks a nav link loses all of it silently.
 */
import { useCallback, useEffect, useRef, type ReactElement } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useT } from './i18n/index.js';

/* ───────────────────────── D146 — the server's own attribution ─────────── */

/**
 * A 422's `fields`, keyed by the REQUEST body's paths, rewritten to the ids
 * this particular form gives its inputs.
 *
 * The two vocabularies are genuinely different and a form cannot just print
 * the server's key: `POST /contests` objects to `startTime`, and the input
 * that holds it is called `start`; it objects to `problems.3.points`, and the
 * points for row 4 live in a table nothing can focus by that name. So the
 * caller supplies the dictionary, in one place, next to the request it
 * describes.
 *
 * `*` matches one path segment, which is what makes a per-ROW objection
 * reachable: `problems.*.points` catches every index without the form having
 * to enumerate rows it has not drawn yet.
 *
 * A path with no entry is DROPPED rather than guessed onto a nearby field —
 * the same rule D26 made for `fieldForCode`. An unattributable objection
 * belongs in the banner, where the caller still has the server's `detail`.
 */
export function mapFieldErrors<F extends string>(
  fields: Record<string, string[]> | undefined,
  map: Readonly<Partial<Record<string, F>>>,
): Partial<Record<F, string>> {
  const out: Partial<Record<F, string>> = {};
  for (const [path, messages] of Object.entries(fields ?? {})) {
    // Exact first, so a form that names one specific row keeps that
    // precedence over its own wildcard.
    const field = map[path] ?? map[path.replace(/(^|\.)\d+(?=\.|$)/g, '$1*')];
    if (field === undefined || messages.length === 0) continue;
    // Every objection about the field, not just the last one to be written:
    // zod reports "too short" and "wrong characters" as two issues on one
    // path, and showing one of them sends the reader round the loop twice.
    const joined = messages.join(' ');
    out[field] = out[field] === undefined ? joined : `${out[field]} ${joined}`;
  }
  return out;
}

/* ───────────────────────── D110 — the summary, as a component ──────────── */

/**
 * The Focusable Error Summary (WCAG 3.3.1), lifted verbatim out of
 * `routes/register.tsx` so the other eleven forms can have it.
 *
 * It COMPLEMENTS the inline per-field errors and never replaces them: a
 * reader gets the overview and the per-field objection both. `role="alert"`
 * announces the failure, `tabIndex={-1}` lets focus land on it, and each item
 * is a link that puts focus on the field it names.
 *
 * `attempt` is the whole reason this is not just "focus when errors appear":
 * a SECOND submit that fails the same way does not change the errors object,
 * so a counter bumped on every attempt is what re-takes focus. And because
 * `errors` only ever changes inside a submit handler — typing edits values,
 * never errors — the effect cannot steal focus mid-typing.
 */
export function ErrorSummary<F extends string>(props: {
  /** The failures, keyed by input id. */
  errors: Partial<Record<F, string>>;
  /** The fields in SCREEN order, so the list reads the way the form does. */
  order: readonly F[];
  /** Bumped once per submit attempt by the caller. */
  attempt: number;
}): ReactElement | null {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const { errors, attempt } = props;
  const has = Object.keys(errors).length > 0;
  useEffect(() => {
    if (has) ref.current?.focus();
  }, [attempt, has]);
  if (!has) return null;
  return (
    <div className="error-summary" role="alert" tabIndex={-1} ref={ref}>
      <strong>{t('form.errorSummaryTitle')}</strong>
      <ul>
        {props.order
          .filter((field) => errors[field])
          .map((field) => (
            <li key={field}>
              {/* `#${id}` is a real fragment for a pointer; the handler is
                  what actually moves DOM focus, which a hash href does not
                  do on its own (and jsdom does not act on at all). */}
              <a
                href={`#${field}`}
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(field)?.focus();
                }}
              >
                {errors[field]}
              </a>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * The `aria-*` wiring one input needs to own its objection.
 *
 * Spread onto the `<input>`; render `<FieldError>` with the same id beside
 * it. The error is the field's DESCRIPTION, never part of its NAME — see
 * `register.tsx`'s note on why a wrapping `<label>` must not contain it.
 */
export function fieldProps(
  id: string,
  error: string | undefined,
): { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return {
    id,
    ...(error === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` }),
  };
}

/** The objection itself, carrying the id `fieldProps` pointed at. */
export function FieldError(props: { id: string; message: string | undefined }): ReactElement | null {
  if (props.message === undefined) return null;
  return (
    <span id={`${props.id}-error`} className="field-error">
      {props.message}
    </span>
  );
}

/* ───────────────────────── D147 — do not lose typed work ───────────────── */

/**
 * "You have unsaved changes" — for the tab AND for an in-app route change.
 *
 * Both halves are needed and neither substitutes for the other.
 * `beforeunload` covers a closed tab, a reload and the back button out of the
 * app; a TanStack Router navigation never fires it, and clicking *Hủy* or a
 * nav link is by far the likelier way a half-written contest dies. The
 * router's own `useBlocker` takes `enableBeforeUnload` as well, but this hook
 * registers the listener itself so a caller rendered outside a
 * `RouterProvider` still gets the tab guard.
 *
 * `disabled` rather than a conditional call: hooks cannot be conditional, and
 * a blocker that is registered-but-off is exactly what the option is for. The
 * text is the browser's own — no page has been able to choose that wording
 * for a decade, and `preventDefault()` is what actually raises the dialog.
 */
export function useDirtyGuard(dirty: boolean): () => void {
  /**
   * Disarmed SYNCHRONOUSLY, by the handler that is about to navigate on a
   * successful save.
   *
   * A ref rather than a state flag, and this is the whole subtlety: the save
   * handler sets it and calls `navigate()` in the same tick, so React has not
   * necessarily re-rendered and `disabled` may still be `false` when the
   * router asks. `shouldBlockFn` reads the ref, so the guard cannot block the
   * very navigation that means the work is safe.
   */
  const released = useRef(false);
  const armed = dirty && !released.current;
  const armedRef = useRef(armed);
  armedRef.current = armed;

  useEffect(() => {
    if (!armed) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Legacy Safari/Chrome still key off a non-empty `returnValue`; the
      // string itself has been ignored by every browser for years.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [armed]);

  useBlocker({
    shouldBlockFn: () => armedRef.current && !window.confirm(CONFIRM_LEAVE.text),
    disabled: !armed,
  });

  return useCallback(() => {
    released.current = true;
    armedRef.current = false;
  }, []);
}

/**
 * The leave-confirmation sentence, in a mutable holder rather than a `t()`
 * call inside `shouldBlockFn`.
 *
 * `useBlocker`'s callback is invoked by the router outside React's render, so
 * it cannot read a hook; and `window.confirm` is the only prompt a blocker
 * can answer synchronously. `DirtyGuardText` keeps the holder in step with
 * the active locale, so the sentence is still D18-correct.
 */
const CONFIRM_LEAVE = { text: 'Bạn có thay đổi chưa lưu. Rời khỏi trang?' };

/**
 * Renders nothing; keeps `useDirtyGuard`'s confirm text in the active
 * locale. Mounted once, in the shell.
 */
export function DirtyGuardText(): null {
  const t = useT();
  const text = t('form.leaveConfirm');
  useEffect(() => {
    CONFIRM_LEAVE.text = text;
  }, [text]);
  return null;
}

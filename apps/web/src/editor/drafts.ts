/**
 * Per-(problem, language) drafts of the submit editor's buffer.
 *
 * A pupil on a shared school machine loses a half-written solution to a
 * reload, a stray back-button or a lab bell; nothing on this site remembered
 * it, because a `<textarea>` remembers nothing. D84.
 *
 * Every `localStorage` access is wrapped, exactly as `i18n/index.tsx`'s
 * locale read is: the API THROWS (rather than returning `null`) in a browser
 * configured to block site data and inside several embedded webviews, and a
 * convenience is not worth taking the submit screen down for.
 */
import { useCallback, useEffect, useRef } from 'react';

/** Versioned so a future change of shape cannot be read as this one. */
export const DRAFT_PREFIX = 'duckoj.draft.v1';

/**
 * Long enough that a fast typist writes a whole line between writes, short
 * enough that a reload a second after the last keystroke still has it.
 */
export const DRAFT_DEBOUNCE_MS = 500;

/**
 * The key is (problem, language), not (problem): a pupil who tried C++ and
 * then switched to Python has two different half-finished programs, and
 * one key would silently overwrite the first with the second.
 */
export function draftKey(problemCode: string, languageKey: string): string {
  return `${DRAFT_PREFIX}:${problemCode}:${languageKey}`;
}

export function loadDraft(key: string): string | null {
  try {
    const stored = globalThis.localStorage.getItem(key);
    return stored === null || stored === '' ? null : stored;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, source: string): void {
  try {
    // An empty buffer is an ERASED draft, never a stored empty string: a
    // pupil who selects-all and deletes has abandoned it, and restoring
    // `''` on their return would print a "draft restored" notice over an
    // empty editor.
    if (source === '') globalThis.localStorage.removeItem(key);
    else globalThis.localStorage.setItem(key, source);
  } catch {
    // Storage full or blocked. The buffer on screen is unaffected.
  }
}

export function clearDraft(key: string): void {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    // as above
  }
}

/**
 * The debounced writer, plus the one thing a plain `useEffect` debounce gets
 * wrong: a `clear()` on a successful submit must also CANCEL the write
 * already scheduled, or the 500 ms timer resurrects the draft the submit
 * just cleared. That race is asserted directly in `test/editor-draft.spec.tsx`.
 *
 * The pending value is flushed on unmount, and by `flush()` when the submit
 * page changes language, rather than dropped — so navigating away within the
 * debounce window keeps the last keystrokes, flushed to the key it was
 * SCHEDULED with, which is what makes a language switch mid-window file the
 * old buffer under the old language.
 */
export function useDraft(
  problemCode: string,
  languageKey: string,
): {
  key: string;
  schedule: (source: string) => void;
  /** Writes a pending value NOW, under the key it was scheduled with. */
  flush: () => void;
  clear: () => void;
} {
  const key = draftKey(problemCode, languageKey);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ key: string; source: string } | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
  }, []);

  const schedule = useCallback(
    (source: string) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      pendingRef.current = { key, source };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending) saveDraft(pending.key, pending.source);
      }, DRAFT_DEBOUNCE_MS);
    },
    [key],
  );

  /**
   * Writes whatever is pending immediately, under the key it was SCHEDULED
   * with — never the current one.
   *
   * Needed by the language switch (D158's sibling fix): the switch reads the
   * target language's stored draft, and a write still sitting in the debounce
   * window would otherwise land after that read and under a key the pupil has
   * already left. Idempotent, and a no-op when nothing is pending.
   */
  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) saveDraft(pending.key, pending.source);
  }, []);

  const clear = useCallback(() => {
    cancel();
    clearDraft(key);
  }, [cancel, key]);

  // On unmount only (`flush` is stable), so navigating away inside the
  // debounce window still keeps the last keystrokes.
  useEffect(() => () => flush(), [flush]);

  return { key, schedule, flush, clear };
}

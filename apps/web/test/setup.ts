import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { LOCALE_STORAGE_KEY, resetFallbackLocale } from '../src/i18n/index.js';
import { THEME_STORAGE_KEY } from '../src/theme.js';

// `vite.config.ts` sets `test.globals: false`, so `afterEach` is never a
// global — and @testing-library/react's automatic cleanup relies on exactly
// that global existing to register itself. Without this, every test's
// rendered DOM survives into the next test in the same file, which silently
// turns "one element" queries into "multiple elements found" failures in any
// spec file with more than one `render()` call.
afterEach(cleanup);

/**
 * D143's rule, in the shape this package needs.
 *
 * `findBy*` and `waitFor` do NOT run on vitest's `testTimeout`; Testing
 * Library keeps its own budget, and it defaults to **one second**. That is
 * ample when the web suite runs alone and much too little when it does not:
 * `pnpm -r test` starts every package at once, so sixty jsdom files render
 * React while `apps/api`, `apps/judged` and `packages/db` are churning
 * through a hundred and thirty Postgres containers on the same machine.
 * `submission-diff.spec.tsx` went red on exactly that — "Unable to find
 * role=button" for a toggle that renders after two react-query fetches — and
 * passed alone, the same sentence twenty hunt reports have filed under
 * "container contention".
 *
 * Five seconds is far outside any honest render and still fails a genuinely
 * missing element quickly. It is set HERE, once, for the same reason the api
 * floor lives in a vitest config: a per-call `{ timeout }` argument is a
 * thing every future spec has to remember.
 *
 * `vite.config.ts` raises vitest's own `testTimeout` to match — a case that
 * spends five seconds inside one `findBy` must not then die on a five-second
 * case budget.
 */
configure({ asyncUtilTimeout: 5_000 });

// jsdom's `documentElement` and `localStorage` persist across the tests in a
// file. The theme control (D116) writes both, so a test that leaves a
// `data-theme` on `<html>` or a `duckoj.theme` in storage would silently tint
// the next test's assertions. Clear both after every test.
afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // storage unavailable in this test — nothing to clear
  }
});

// Pin the suite to the app's real default locale.
//
// jsdom reports `navigator.language === 'en-US'`, so `resolveInitialLocale`
// would answer `en` for every bare render — the whole unit suite would then
// exercise a locale no Vietnamese visitor ever sees, and the assertions in
// it would prove nothing about the shipped default. Seeding the same key the
// app persists to is the least magical way to say "render as a first-time
// Vietnamese visitor"; a test that wants English wraps its render in
// `<LocaleProvider initialLocale="en">`.
localStorage.setItem(LOCALE_STORAGE_KEY, 'vi');
resetFallbackLocale();

/**
 * CodeMirror 6 (D84) touches four browser APIs jsdom does not implement.
 * Without these the submit form throws on mount and every spec that renders
 * it fails with something that looks nothing like the bug it has.
 *
 * They are stubs, not polyfills: jsdom does no layout, so every measurement
 * CodeMirror takes is zero either way. What matters is that the calls return
 * instead of throwing — the document model, the keymap and the transactions
 * (which is all these tests assert on) are pure JavaScript and work exactly
 * as they do in a browser.
 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

// jsdom's Range implements neither, and CodeMirror measures a Range on every
// view update to decide where the cursor is.
Range.prototype.getClientRects ??= function getClientRects(): DOMRectList {
  return Object.assign([], { item: () => null }) as unknown as DOMRectList;
};
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

// Not implemented by jsdom at all; CodeMirror calls it when a transaction
// scrolls the selection into view.
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

// `document.getSelection()` exists in jsdom but answers `null` inside a
// detached tree, which CodeMirror dereferences.
if (document.getSelection() === null) {
  document.getSelection = () =>
    ({
      anchorNode: null,
      focusNode: null,
      rangeCount: 0,
      addRange: () => {},
      removeAllRanges: () => {},
      collapse: () => {},
      extend: () => {},
      getRangeAt: () => new Range(),
    }) as unknown as Selection;
}

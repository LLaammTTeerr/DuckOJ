import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { LOCALE_STORAGE_KEY, resetFallbackLocale } from '../src/i18n/index.js';

// `vite.config.ts` sets `test.globals: false`, so `afterEach` is never a
// global — and @testing-library/react's automatic cleanup relies on exactly
// that global existing to register itself. Without this, every test's
// rendered DOM survives into the next test in the same file, which silently
// turns "one element" queries into "multiple elements found" failures in any
// spec file with more than one `render()` call.
afterEach(cleanup);

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

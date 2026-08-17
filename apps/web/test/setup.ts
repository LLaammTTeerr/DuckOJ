import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `vite.config.ts` sets `test.globals: false`, so `afterEach` is never a
// global — and @testing-library/react's automatic cleanup relies on exactly
// that global existing to register itself. Without this, every test's
// rendered DOM survives into the next test in the same file, which silently
// turns "one element" queries into "multiple elements found" failures in any
// spec file with more than one `render()` call.
afterEach(cleanup);

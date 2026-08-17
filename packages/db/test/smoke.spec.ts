import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('workspace wiring', () => {
  it('resolves the package entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@qhhoj/db');
  });
});

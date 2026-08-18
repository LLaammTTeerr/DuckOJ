import { describe, expect, it } from 'vitest';
import { SUBMISSION_CHANNEL } from '../src/channels.js';

describe('SUBMISSION_CHANNEL', () => {
  it('is a non-empty channel name both judged and api can agree on by import', () => {
    expect(typeof SUBMISSION_CHANNEL).toBe('string');
    expect(SUBMISSION_CHANNEL.length).toBeGreaterThan(0);
  });
});

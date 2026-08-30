/**
 * The problem+json mapping on its own, including the responses that are NOT
 * problem+json — a proxy's 502 with an HTML body, a `fetch` that rejected —
 * because those are the ones a caller meets when something is genuinely
 * wrong and the ones a mapping written only against the happy path drops.
 */
import { describe, expect, it } from 'vitest';
import { ApiFailure, asApiFailure, unwrap } from '../src/errors.js';

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response('', { status, headers });
}

describe('ApiFailure.from', () => {
  it('keeps the API\'s own code and detail', () => {
    const failure = ApiFailure.from(response(422), {
      code: 'problem_editorial_empty',
      detail: 'an editorial cannot be published empty',
      status: 422,
    });
    expect(failure.code).toBe('problem_editorial_empty');
    expect(failure.detail).toBe('an editorial cannot be published empty');
  });

  it('names a code per status when the body carried none', () => {
    expect(ApiFailure.from(response(401), null).code).toBe('unauthorized');
    expect(ApiFailure.from(response(403), null).code).toBe('forbidden');
    expect(ApiFailure.from(response(404), null).code).toBe('not_found');
    expect(ApiFailure.from(response(502), 'a gateway HTML page').code).toBe('server_error');
    expect(ApiFailure.from(undefined, null).code).toBe('transport_error');
  });

  it('falls back to the title when there is no detail', () => {
    expect(ApiFailure.from(response(409), { code: 'x', title: 'Conflict' }).detail).toBe('Conflict');
  });

  it('reads Retry-After as whole seconds, and ignores a useless one', () => {
    expect(
      ApiFailure.from(response(429, { 'Retry-After': '12' }), { code: 'submission_rate_limited' })
        .retryAfterSeconds,
    ).toBe(12);
    expect(
      ApiFailure.from(response(429, { 'Retry-After': '0' }), { code: 'x' }).retryAfterSeconds,
    ).toBeUndefined();
    expect(
      ApiFailure.from(response(429, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }), { code: 'x' })
        .retryAfterSeconds,
    ).toBeUndefined();
  });

  it('omits the optional members from the JSON rather than nulling them', () => {
    expect(ApiFailure.from(response(404), { code: 'nope', detail: 'gone' }).toJSON()).toEqual({
      error: { code: 'nope', detail: 'gone', status: 404 },
    });
  });
});

describe('unwrap', () => {
  it('returns the data on a success', () => {
    expect(unwrap({ data: { id: 1 }, response: response(200) })).toEqual({ id: 1 });
  });

  it('throws the mapped failure on an error body', () => {
    expect(() =>
      unwrap({ error: { code: 'nope', detail: 'no' }, response: response(404) }),
    ).toThrow(ApiFailure);
  });

  it('throws on a 200 with no body, rather than handing `undefined` on', () => {
    expect(() => unwrap({ response: response(200) })).toThrow(ApiFailure);
  });
});

describe('asApiFailure', () => {
  it('passes an ApiFailure through untouched', () => {
    const failure = new ApiFailure({ code: 'a', status: 1, detail: 'b' });
    expect(asApiFailure(failure)).toBe(failure);
  });

  it('wraps a thrown transport error', () => {
    const failure = asApiFailure(new TypeError('fetch failed'));
    expect(failure.code).toBe('transport_error');
    expect(failure.status).toBe(0);
    expect(failure.detail).toBe('fetch failed');
  });
});

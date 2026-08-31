import type { QueryClient } from '@tanstack/react-query';
import { api } from './api.js';

/**
 * `GET /auth/me`, as a shared query-options object rather than inlined at
 * every call site — moved here (out of `router.tsx`, where it originally
 * lived) so a route component that is not itself part of the route tree
 * (`routes/problems.tsx`, which needs the viewer's username for the `me`
 * verdict column) can read the same cached `['me']` entry without importing
 * `router.tsx` and dragging the real `createRouter` — and every route file
 * it wires together — into that component's module graph. A route file
 * importing a route COMPONENT already happens (`router.tsx` imports
 * `ProblemsPage`); the reverse would be a cycle.
 */
export function fetchMe() {
  return api.GET('/auth/me').then(({ data }) => data ?? null);
}

export const meQueryOptions = { queryKey: ['me'] as const, queryFn: fetchMe };

/**
 * Drops every cached answer that belonged to the viewer who is leaving.
 *
 * Called on BOTH sides of a viewer swap — signing out and signing in — which
 * is the whole reason it is a function rather than a line in each. Sign-out
 * had this logic and sign-in did not, so on a shared school machine the
 * sequence that matters (a session ends without the button — it expired, or a
 * password change elsewhere revoked it — and the next pupil signs in on the
 * same tab) left the previous pupil's notification feed, submissions, teams
 * and private problem lists in the store, to be rendered under the new
 * person's session until each one happened to refetch.
 *
 * **Everything except `['me']`.** That entry is the identity the whole shell
 * keys off — every `enabled` flag reads it — and removing it makes a mounted
 * observer go on rendering the data it last saw (see `SignOutButton`, which
 * learned this the hard way and sets it rather than dropping it). Its callers
 * decide what `['me']` becomes: `null` on the way out, a refetch on the way
 * in.
 */
export function dropDepartingViewerCache(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
}

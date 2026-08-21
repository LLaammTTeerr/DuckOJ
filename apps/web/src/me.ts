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

import { z } from 'zod';
import { PaginationQuery, ProblemDetails, Timestamp, cursorPage } from './common.js';
import { registry } from './registry.js';

/**
 * A user as anyone may see them.
 *
 * What is absent is the design (3d §3). `email` is never public. `status` is a
 * moderation fact — exposing it would make this route an oracle for who has
 * been suspended. `timezone` and `locale` are preferences, not identity, and
 * belong to `GET /auth/me`. `avatarKey` is omitted until something can resolve
 * it into a URL; returning a key nobody can dereference is worse than nothing.
 */
export const UserSummary = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  /** A setter/admin badge. Useful, and reveals nothing a listing would not. */
  globalRole: z.enum(['user', 'setter', 'admin']),
  country: z.string().nullable(),
  rating: z.number().int().nullable(),
  maxRating: z.number().int().nullable(),
  createdAt: Timestamp,
});
export type UserSummaryDto = z.infer<typeof UserSummary>;

/**
 * Counted over **public problems only**, so the numbers mean the same thing to
 * every reader.
 *
 * Counting what the *viewer* may see would make a profile differ per viewer
 * and would leak, through arithmetic, that private problems exist. DMOJ does
 * the same — `calculate_points` runs against `Problem.get_public_problems()`.
 */
export const UserStats = z.object({
  /** Distinct public problems with at least one `AC`. */
  solvedCount: z.number().int(),
  /** Sum, over public problems, of this user's best score on each. */
  points: z.number(),
  /** Submissions to public problems. */
  submissionCount: z.number().int(),
});
export type UserStatsDto = z.infer<typeof UserStats>;

export const UserProfile = UserSummary.extend({
  about: z.string().nullable(),
  stats: UserStats,
});
export type UserProfileDto = z.infer<typeof UserProfile>;

export const UserPage = cursorPage(UserSummary);
export type UserPageDto = z.infer<typeof UserPage>;

export const UserListQuery = PaginationQuery.extend({
  /**
   * Case-insensitive **prefix** of username or display name.
   *
   * Prefix rather than substring on purpose: `LIKE '%q%'` cannot use an index,
   * so a two-letter query would sequentially scan every user. The existing
   * `users_username_lower_idx` serves a prefix directly.
   */
  q: z.string().min(1).max(64).optional(),
});
export type UserListQueryDto = z.infer<typeof UserListQuery>;

/**
 * What a user may change about themselves.
 *
 * `.strict()` so `username`, `email`, `globalRole` and `rating` are *rejected*
 * rather than silently ignored — a request that appears to have worked and did
 * not is worse than a 422.
 */
export const UpdateMeRequest = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    about: z.string().max(4000).nullable().optional(),
    country: z.string().min(2).max(64).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    locale: z.string().min(2).max(16).optional(),
  })
  .strict();
export type UpdateMeRequestDto = z.infer<typeof UpdateMeRequest>;

/** Declared so the generated SDK types `{ params: { path: { username } } }`. */
const UsernameParam = z.object({ username: z.string() });

const USER_NOT_FOUND = {
  description: 'No such user',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'get',
  path: '/users',
  summary: 'Search users by username or display name prefix',
  request: { query: UserListQuery },
  responses: {
    200: { description: 'A page of users', content: { 'application/json': { schema: UserPage } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/users/{username}',
  summary: 'A user profile, with statistics over public problems',
  request: { params: UsernameParam },
  responses: {
    200: { description: 'The profile', content: { 'application/json': { schema: UserProfile } } },
    404: USER_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/users/me',
  summary: 'Edit your own profile',
  request: { body: { content: { 'application/json': { schema: UpdateMeRequest } } } },
  responses: {
    200: { description: 'The updated profile', content: { 'application/json': { schema: UserProfile } } },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'Validation failed — including an attempt to change an unowned field',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

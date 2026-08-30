import { z } from 'zod';
import { PaginationQuery, ProblemDetails, Timestamp, cursorPage } from './common.js';
import { DisplayName } from './auth.js';
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
 * Whether the platform can actually resolve this as an IANA time zone.
 *
 * `timezone` and `locale` are stored so the server can one day format times
 * and messages the way their owner asked. Accepted as free text, the first
 * thing to hand either to `Intl` throws a `RangeError` on a value its owner
 * typed months before — a 500 with no route back to the request that caused
 * it. Checking here is the only place the bad value is still attached to
 * someone who can be told.
 *
 * The check is *shape*, deliberately, not membership: any real zone is fine,
 * not only `Asia/Ho_Chi_Minh`, and any well-formed BCP-47 tag is fine, not
 * only the two locales the web ships today (D18). Narrowing either to a list
 * would be a product ruling, and would break the moment the list grows.
 */
function isResolvableTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isWellFormedLocale(value: string): boolean {
  try {
    // Throws `RangeError` on a structurally invalid tag; canonicalisation of
    // an unknown-but-well-formed one (`qq-XX`) succeeds, which is the right
    // side to err on for a preference nothing authoritative enumerates.
    return Intl.getCanonicalLocales(value).length > 0;
  } catch {
    return false;
  }
}

/**
 * What a user may change about themselves.
 *
 * `.strict()` so `username`, `email`, `globalRole` and `rating` are *rejected*
 * rather than silently ignored — a request that appears to have worked and did
 * not is worse than a 422.
 */
export const UpdateMeRequest = z
  .object({
    displayName: DisplayName.optional(),
    about: z.string().max(4000).nullable().optional(),
    country: z.string().min(2).max(64).nullable().optional(),
    /**
     * `null` is a real value for both, and a different one from absent: it
     * CLEARS the preference, putting the reader back on their browser's own
     * zone and language (D57). Absent still means "leave it alone" — the
     * settings screen sends both on every save, so it needs a way to say
     * "no preference" that is not a value.
     */
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isResolvableTimeZone, 'must be an IANA time zone name, such as Asia/Ho_Chi_Minh')
      .nullable()
      .optional(),
    locale: z
      .string()
      .min(2)
      .max(16)
      .refine(isWellFormedLocale, 'must be a BCP-47 language tag, such as vi or en')
      .nullable()
      .optional(),
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
  tags: ['Users'],
  summary: 'Search users by username or display name prefix',
  request: { query: UserListQuery },
  responses: {
    200: { description: 'A page of users', content: { 'application/json': { schema: UserPage } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/users/{username}',
  tags: ['Users'],
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
  tags: ['Users'],
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

/* ------------------------------------------------- progress (F16, D83) --- */

/**
 * One bar of the tag or difficulty breakdown.
 *
 * `attempted` counts problems with at least one submission, `solved` those
 * with at least one `AC` — **problems, never submissions**: eleven attempts
 * at one problem is one attempt at one problem, which is the only reading
 * under which a bar means "how much of this topic have I got through".
 */
export const ProgressBar = z.object({
  attempted: z.number().int(),
  solved: z.number().int(),
});

export const TagProgress = ProgressBar.extend({
  slug: z.string(),
  nameVi: z.string(),
  nameEn: z.string(),
});
export type TagProgressDto = z.infer<typeof TagProgress>;

/** `null` is the unrated bucket — exactly what an unrated problem carries. */
export const DifficultyProgress = ProgressBar.extend({
  difficulty: z.number().int().min(1).max(10).nullable(),
});
export type DifficultyProgressDto = z.infer<typeof DifficultyProgress>;

/**
 * One day of the activity heatmap. `date` is a calendar day in the SUBJECT's
 * own zone (D57), not UTC and not the reader's — a day is where the person
 * who did the work was standing.
 */
export const ActivityDay = z.object({
  /** `YYYY-MM-DD`. */
  date: z.string(),
  count: z.number().int(),
});
export type ActivityDayDto = z.infer<typeof ActivityDay>;

export const ActivityHeatmap = z.object({
  /** The IANA zone the days were bucketed in — the client must not re-bucket. */
  timezone: z.string(),
  from: z.string(),
  to: z.string(),
  /** Sparse: a day with no submissions is absent, not a zero. */
  days: z.array(ActivityDay),
});
export type ActivityHeatmapDto = z.infer<typeof ActivityHeatmap>;

/**
 * What a public profile's progress panel says. Counted over **public
 * problems only**, exactly like `UserStats` and for its reason (§3/§4): a
 * number that changed with who was reading it would leak, by arithmetic,
 * that a private problem exists.
 */
export const UserProgress = z.object({
  byTag: z.array(TagProgress),
  byDifficulty: z.array(DifficultyProgress),
  heatmap: ActivityHeatmap,
});
export type UserProgressDto = z.infer<typeof UserProgress>;

/** Consecutive days with at least one counted `AC`, in the account's zone. */
export const ProgressStreak = z.object({
  current: z.number().int(),
  longest: z.number().int(),
  /** `YYYY-MM-DD` of the most recent day with an `AC`, or `null`. */
  lastDate: z.string().nullable(),
});
export type ProgressStreakDto = z.infer<typeof ProgressStreak>;

export const RecentVerdict = z.object({
  id: z.number().int(),
  problemCode: z.string(),
  problemName: z.string(),
  verdict: z.string().nullable(),
  points: z.number().nullable(),
  createdAt: Timestamp,
});
export type RecentVerdictDto = z.infer<typeof RecentVerdict>;

/** A contest this person has joined whose own window has not closed yet. */
export const UpcomingContest = z.object({
  key: z.string(),
  name: z.string(),
  startTime: Timestamp,
  endTime: Timestamp,
  /** THEIR window's end — a virtual entrant's outlives the contest's (D22). */
  endsAt: Timestamp,
});
export type UpcomingContestDto = z.infer<typeof UpcomingContest>;

/** A dated homework set from one of this person's schools (D66). */
export const UpcomingHomework = z.object({
  orgSlug: z.string(),
  orgName: z.string(),
  slug: z.string(),
  name: z.string(),
  deadline: Timestamp,
  /** Problems in the set, and how many of them this pupil has solved. */
  total: z.number().int(),
  solved: z.number().int(),
});
export type UpcomingHomeworkDto = z.infer<typeof UpcomingHomework>;

/**
 * Your own progress page. Everything `UserProgress` has, over every problem
 * you have submitted to rather than only the public ones, plus the four
 * panels that are nobody else's business: your streak, your last verdicts,
 * the contests you are sitting and the homework you owe.
 */
export const MyProgress = UserProgress.extend({
  streak: ProgressStreak,
  recent: z.array(RecentVerdict),
  upcomingContests: z.array(UpcomingContest),
  homework: z.array(UpcomingHomework),
});
export type MyProgressDto = z.infer<typeof MyProgress>;

registry.registerPath({
  method: 'get',
  path: '/users/me/progress',
  tags: ['Users'],
  summary: 'Your own progress: bars, heatmap, streak, recent verdicts, what is due',
  responses: {
    200: {
      description: 'The progress page',
      content: { 'application/json': { schema: MyProgress } },
    },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/users/{username}/progress',
  tags: ['Users'],
  summary: 'A public profile’s tag and difficulty bars and activity heatmap',
  request: { params: UsernameParam },
  responses: {
    200: {
      description: 'The public half of the progress page',
      content: { 'application/json': { schema: UserProgress } },
    },
    404: USER_NOT_FOUND,
  },
});

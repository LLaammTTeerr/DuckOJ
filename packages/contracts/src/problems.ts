import { z } from 'zod';
import {
  MEMORY_EXTRA_KB_MAX,
  MEMORY_EXTRA_KB_MIN,
  TIME_MULTIPLIER_PCT_MAX,
  TIME_MULTIPLIER_PCT_MIN,
} from '@duckoj/language-limits';
import { PaginationQuery, ProblemDetails, Timestamp, cursorPage } from './common.js';
import { registry } from './registry.js';
import { Difficulty, DifficultyQuery, Tag } from './tags.js';
import { Verdict } from './submissions.js';

export const PROBLEM_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const ProblemVisibility = z.enum(['private', 'org', 'public']);
export type ProblemVisibilityDto = z.infer<typeof ProblemVisibility>;

/**
 * Who, beyond the submitter, an admin, and this problem's authors/curators,
 * may read submissions to it. `private` is the default every problem starts
 * on; `solved` additionally admits anyone holding an `AC`. There is no
 * `public` member — design §2.3.
 */
export const ProblemSourceAccess = z.enum(['private', 'solved']);
export type ProblemSourceAccessDto = z.infer<typeof ProblemSourceAccess>;

export const ProblemRole = z.enum(['author', 'curator', 'tester']);
export type ProblemRoleDto = z.infer<typeof ProblemRole>;

export const ProblemMember = z.object({ username: z.string().min(1), role: ProblemRole });
export type ProblemMemberDto = z.infer<typeof ProblemMember>;

export const CreateProblemRequest = z.object({
  code: z.string().regex(PROBLEM_CODE),
  name: z.string().min(1).max(200),
  // 256 KiB: far above any real statement, far below anything that hurts.
  statement: z.string().max(262_144),
  visibility: ProblemVisibility.default('private'),
  orgSlugs: z.array(z.string()).default([]),
});
export type CreateProblemRequestDto = z.infer<typeof CreateProblemRequest>;

/**
 * `POST /problems/{code}/clone` — a new problem seeded from an existing one
 * (D88).
 *
 * Only the two things a copy cannot inherit: a problem's code is its URL and
 * must be new, and a name may be given so the copy is distinguishable in a
 * list. Everything else that is carried across is decided by the server, not
 * asked for here — a request that could choose what to copy would be a
 * second, half-specified `POST /problems`.
 */
export const CloneProblemRequest = z
  .object({
    newCode: z.string().regex(PROBLEM_CODE),
    /** Defaults to the source's own name. */
    newName: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CloneProblemRequestDto = z.infer<typeof CloneProblemRequest>;

export const UpdateProblemRequest = z
  .object({
    name: z.string().min(1).max(200).optional(),
    statement: z.string().max(262_144).optional(),
    visibility: ProblemVisibility.optional(),
    // Settable over the API, per design §5; the authoring screen does not
    // render it yet, which is why this is `.optional()` and not part of
    // `CreateProblemRequest` — a problem is created closed and opened
    // deliberately, never as a default nobody chose.
    sourceAccess: ProblemSourceAccess.optional(),
    orgSlugs: z.array(z.string()).optional(),
    members: z.array(ProblemMember).optional(),
    /**
     * Tag **slugs**, and a whole-set replacement like `members`/`orgSlugs`
     * — never a merge. Written by reference and read back expanded (a
     * `ProblemDetail` carries full `Tag` objects), the same asymmetry
     * `members` has between a username on the way in and a row on the way
     * out. An unknown slug is a 422 `problem_tag_unknown`, not the blurred
     * `problem_org_unknown` its neighbour uses: the tag vocabulary is
     * public (`GET /tags` is `@Public()`), so there is no existence to
     * leak by naming which slug was wrong.
     */
    tags: z.array(z.string()).max(20).optional(),
    /**
     * `null` clears the estimate; omitting the key leaves it. The two are
     * different requests, which is why this is `.nullable().optional()`
     * rather than either alone.
     */
    difficulty: Difficulty.nullable().optional(),
    /**
     * The editorial's Markdown (D43), same vi+en shape as `statement`
     * (D10). `null` clears it — and, because a published editorial with no
     * text is not a state the product has a meaning for, clearing also
     * unpublishes. Omitting the key leaves both alone.
     */
    editorial: z.string().max(262_144).nullable().optional(),
    /**
     * Publishes or unpublishes what is stored. Deliberately a boolean and
     * not a timestamp: *when* it was published is the server's to decide,
     * and re-publishing an already-published editorial does not move the
     * date. `true` against an empty (or absent) editorial is refused with
     * 422 `problem_editorial_empty` rather than silently publishing a page
     * that renders blank.
     */
    editorialPublished: z.boolean().optional(),
    /**
     * The `version` this client read before it started editing — D161.
     *
     * Present, and no longer current, is a 409 `problem_version_conflict` and
     * **nothing is written**: two teachers had one problem open, and the
     * second save would otherwise have replaced the first one's work with a
     * copy taken before it existed. These forms send the whole object on every
     * save, so the field at risk is every field, not the one that was typed
     * in.
     *
     * **Absent means unchecked**, deliberately. This API is a documented
     * surface with personal access tokens behind it, and refusing every PATCH
     * that had not first read a detail would break automation that never had
     * this problem. The rule is "a client that says what it believes it is
     * overwriting will not be allowed to overwrite something else"; the edit
     * form says it, on every save.
     */
    expectedVersion: z.string().optional(),
  })
  // Rejecting an unknown key is what turns "code is immutable" from a
  // comment into a rule: a PATCH carrying `code` fails validation instead of
  // silently renaming nothing. zod reports an unrecognized key as a generic
  // `unrecognized_keys` issue (422 `validation_failed` once `ZodValidationPipe`
  // gets hold of it) with no way to tell "code" apart from any other typo at
  // this layer — `problems.controller.ts`'s `UpdateProblemBodyPipe` special-
  // cases `code` specifically, ahead of this schema, to surface the 400
  // `problem_code_immutable` the spec names.
  .strict();
export type UpdateProblemRequestDto = z.infer<typeof UpdateProblemRequest>;

/**
 * A `?tag=` filter is **repeatable and ANDed**: `?tag=do-thi&tag=quy-hoach-dong`
 * asks for problems carrying BOTH, which is what a teacher building a
 * practice set on "DP on graphs" means. OR is expressible client-side as two
 * requests; AND is not expressible at all without this.
 *
 * Capped at 10 terms — a filter naming more tags than the vocabulary has
 * useful intersections is a mistake or a probe, and the cap bounds the
 * `HAVING count(*)` join below it.
 */
const TAG_FILTER_MAX = 10;

/**
 * Two schemas for one query, mirroring `RevisionVersionParam` and for the
 * same reason: the shape that documents correctly is not the shape that
 * parses correctly.
 *
 * `ProblemListQuery` is what `registry.registerPath` documents — `tag` as a
 * plain `array of string`, which OpenAPI 3.1 renders (style `form`, explode
 * true, both defaults) as exactly the repeated `?tag=a&tag=b` this accepts.
 * `ProblemListQueryParse` is what `ZodValidationPipe` actually runs, and it
 * additionally accepts the *single* occurrence Express hands over as a bare
 * string rather than a one-element array. Documenting the union instead
 * would emit an `anyOf` query parameter, which generators handle badly and
 * which describes an implementation detail of Express, not the contract.
 */
/**
 * A per-viewer filter on the problem list (D125). Authenticated only — an
 * anonymous caller who sends it is answered 422 `status_requires_auth`, never
 * silently ignored, because ignoring it would answer `?status=solved` with a
 * page of problems the caller has not solved (a wrong 200).
 *
 * "solved" is window-gated exactly as D49's `solvedCount` is: an `AC` made
 * inside a still-open contest window does not count until the window closes,
 * so the ✓ marker flips at the same instant the viewer joins the public
 * `solvedCount`. Such an in-window `AC` is still a submission, so it reads
 * "attempted" meanwhile — see `myStatus`.
 */
export const ProblemStatusFilter = z.enum(['solved', 'attempted', 'unsolved']);
export type ProblemStatusFilterDto = z.infer<typeof ProblemStatusFilter>;

export const ProblemListQuery = PaginationQuery.extend({
  q: z.string().max(100).optional(),
  tag: z.array(z.string().max(64)).max(TAG_FILTER_MAX).optional(),
  difficultyMin: DifficultyQuery.optional(),
  difficultyMax: DifficultyQuery.optional(),
  status: ProblemStatusFilter.optional(),
});
export type ProblemListQueryDto = z.infer<typeof ProblemListQuery>;

export const ProblemListQueryParse = ProblemListQuery.extend({
  tag: z
    .preprocess(
      (value) => (value === undefined || Array.isArray(value) ? value : [value]),
      z.array(z.string().max(64)).max(TAG_FILTER_MAX),
    )
    .optional(),
});

export const AttachRevisionRequest = z.object({
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().max(4096).optional(),
});
export type AttachRevisionRequestDto = z.infer<typeof AttachRevisionRequest>;

/**
 * The viewer's own best submission on this problem — spec
 * `2026-08-21-best-verdict-design.md` §2/§3, extended per coordinator review
 * (2026-08-21) to make CE/IE representable rather than invisible. "Best" is
 * maximum `points`, ties broken by the earliest submission; an accepted
 * submission already holds maximum points, so this yields `AC` whenever one
 * exists with no special case for it. `null` for an anonymous caller and for
 * a problem the viewer has never submitted (and had graded) — those read
 * identically to a viewer and are not distinguished.
 *
 * `maxPoints` is the submitting revision's total, not the problem's current
 * one (§3): a submission graded against revision 2 was scored out of
 * revision 2's total, and reporting it against revision 3's total would
 * misreport history, the same reasoning that pins `submissions.revisionId`.
 *
 * `maxPoints` (and, unlike the original spec text, `points` too) are
 * nullable: `event-writer.ts`'s `internalError`/`terminated` branches write
 * `verdict: 'IE'` without ever setting `points` or `maxPoints`, and its
 * `compileError` branch writes `points: 0` without `maxPoints`. A viewer
 * whose only submission to a problem is a CE or IE must still see it here
 * (an empty cell reads identically to "never attempted", which is actively
 * wrong for the CE case beginners hit most) — so both fields follow
 * whatever the chosen submission actually recorded, `null` included.
 */
export const ProblemMe = z
  .object({ verdict: Verdict, points: z.number().nullable(), maxPoints: z.number().nullable() })
  .nullable();
export type ProblemMeDto = z.infer<typeof ProblemMe>;

/**
 * The viewer's own catalogue status on a problem, for the ✓/… row marker
 * (D125). `null` means "unsolved" — a visible problem this viewer has no
 * graded submission to — and is spelled as absence, never as an `'unsolved'`
 * member, so the two-valued shape a row draws (a tick, a partial dot, or
 * nothing) maps 1:1 onto the field.
 *
 * `'solved'` is window-gated like D49's `solvedCount`: it needs an `AC` whose
 * contest window has CLOSED, so a viewer's in-contest `AC` reads `'attempted'`
 * — a submission exists — until the round ends, at which instant it flips to
 * `'solved'`. This is deliberately NOT `me.verdict`: `me` is "your verdict,
 * yours the moment it grades" (D23), so `me.verdict === 'AC'` can sit beside
 * `myStatus: 'attempted'` on the same live-contest row without contradiction.
 */
export const ProblemMyStatus = z.enum(['solved', 'attempted']).nullable();
export type ProblemMyStatusDto = z.infer<typeof ProblemMyStatus>;

export const ProblemSummary = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  visibility: ProblemVisibility,
  hasPublishedRevision: z.boolean(),
  timeMs: z.number().int().nullable(),
  memoryKb: z.number().int().nullable(),
  /**
   * Nullable for the same reason `timeMs`/`memoryKb` are: all three come from
   * the published revision, and a problem whose only revision is still a draft
   * has none. Carried on the *summary* so the list can show it without a
   * request per row — deriving it from `ProblemDetail` would be exactly the
   * N+1 the list must not do.
   */
  testCount: z.number().int().nullable(),
  me: ProblemMe,
  /** The viewer's own catalogue status (D125) — see `ProblemMyStatus`. */
  myStatus: ProblemMyStatus,
  /**
   * Expanded, not slugs, and on the **summary** for the same reason
   * `testCount` is: the list renders a chip per tag, and a slug-only
   * response would force either a second request per row or a client-side
   * join against `GET /tags` before anything could be drawn.
   *
   * Ordered by slug, and **empty rather than absent** when D35 hides them:
   * a viewer sitting a running contest that uses this problem sees `[]`,
   * exactly what an untagged problem returns. Two distinguishable states
   * would be the hint the rule exists to withhold.
   */
  tags: z.array(Tag),
  /** `null` for "nobody has said" — and, per D35, for "not while you are sitting the contest". */
  difficulty: Difficulty.nullable(),
  /**
   * How many distinct people have submitted to this problem at all, and how
   * many have an `AC` on it (D49). On the **summary** for the same reason
   * `tags` and `testCount` are: the list draws them on every row, and a
   * second request per row is the N+1 the summary exists to prevent.
   *
   * Both count only submissions whose contest participation window has
   * CLOSED, so a live contest does not publish how its room is doing; and
   * both read `0` for a viewer D35 hides the hint from, which is exactly
   * what a problem nobody has attempted returns. Two distinguishable states
   * would be the hint the rule exists to withhold.
   */
  attemptedCount: z.number().int(),
  solvedCount: z.number().int(),
});
export type ProblemSummaryDto = z.infer<typeof ProblemSummary>;

export const ProblemPage = cursorPage(ProblemSummary);
export type ProblemPageDto = z.infer<typeof ProblemPage>;

/**
 * One worked example, read out of the published revision's package rather
 * than scraped back out of the statement's prose (D94).
 *
 * `input` and `output` are the sample test's own files, byte for byte —
 * trailing newline included. That is deliberate and is the whole point of
 * the field: an agent (or `oj`) feeds `input` to a program and compares its
 * stdout against `output`, and a helpfully-trimmed string would fail that
 * comparison on problems whose checker is not token-based.
 *
 * `explanation` is the setter's prose for this sample (Markdown, same
 * vi+en shape as the statement), or `null` — the manifest's
 * `samples[].explanation`, not a column, because it belongs to the revision
 * that ships the files it explains.
 *
 * `truncated` says a file was longer than the API is willing to inline and
 * has been cut; the sample is still shown, and the statement's own table (or
 * the problem's test data) remains the complete record. A sample big enough
 * to trip this is a sample nobody was going to read off a phone anyway.
 */
export const ProblemSample = z.object({
  input: z.string(),
  output: z.string(),
  explanation: z.string().nullable(),
  truncated: z.boolean(),
});
export type ProblemSampleDto = z.infer<typeof ProblemSample>;

/**
 * The limits ACTUALLY IN FORCE for one language on one problem (D154) —
 * the published revision's authored limits with the language's multiplier
 * and memory floor applied, and the problem's own override resolved over
 * that.
 *
 * Resolved on the server and carried whole, rather than shipping the pupil a
 * multiplier and letting the web app multiply. The arithmetic that decides a
 * verdict exists once, in `@duckoj/db`'s `effectiveLimits`, and the browser
 * re-implementing it is exactly how a scoreboard comes to say 2.0 s about a
 * run the judge gave 6.0 s.
 */
export const ProblemLanguageLimit = z.object({
  languageKey: z.string(),
  /** The language's display name, so a picker need not join against `/languages`. */
  languageName: z.string(),
  /** Milliseconds this language is actually given. */
  timeMs: z.number().int(),
  /** Kilobytes this language is actually given. */
  memoryKb: z.number().int(),
  /**
   * `false` when this problem refuses this language — a setter's "the whole
   * point of this problem is the constant factor" (D154). The picker must
   * omit it, and `POST /submissions` answers 404 for it.
   */
  allowed: z.boolean(),
});
export type ProblemLanguageLimitDto = z.infer<typeof ProblemLanguageLimit>;

/**
 * One language's row on the AUTHORING form (D159) — the inputs, not the
 * result.
 *
 * `ProblemLanguageLimit` above is what a pupil is shown: the arithmetic
 * already done, one pair of numbers, resolved server-side. This is its twin
 * for the setter, and it is deliberately the other shape. A form that edits
 * an override has to render a state the pupil's view cannot express —
 * **inherit**, which is NULL and is not zero — and it has to show a resulting
 * limit for a number that has been typed and not yet saved, which no
 * server-resolved field can answer. So it carries the inputs and `apps/web`
 * applies `effectiveLimits` from `@duckoj/language-limits`: the same
 * function, from the same module, that `apps/api` displays with and
 * `apps/judged` enforces with.
 *
 * That is a narrow amendment to D154's "the web app is never handed a
 * multiplier to apply itself", and it is narrow on purpose: the pupil-facing
 * `ProblemDetail.languageLimits` is unchanged, and the rule D154 was actually
 * defending — one implementation of the arithmetic — is what makes the
 * amendment safe rather than what it breaks.
 */
export const ProblemLanguageLimitSetting = z.object({
  languageKey: z.string(),
  languageName: z.string(),
  /**
   * The language's own default, from `languages` — what a `null` below
   * inherits. Sent so the form can SHOW what "inherit" currently means
   * ("kế thừa: 300 %") instead of showing an empty box that says nothing.
   */
  defaultTimeMultiplierPct: z.number().int(),
  defaultMemoryExtraKb: z.number().int(),
  /**
   * This problem's override, or `null` for "inherit the default above".
   *
   * `null` and `0` are different requests and the difference decides a
   * verdict: a row that pins the time and leaves this `null` keeps the
   * interpreter's memory floor, and one that sent `0` instead would MRE every
   * Python submission on a problem that still accepts them (D154).
   */
  timeMultiplierPct: z
    .number()
    .int()
    .min(TIME_MULTIPLIER_PCT_MIN)
    .max(TIME_MULTIPLIER_PCT_MAX)
    .nullable(),
  memoryExtraKb: z.number().int().min(MEMORY_EXTRA_KB_MIN).max(MEMORY_EXTRA_KB_MAX).nullable(),
  /**
   * `false` refuses this language on this problem — a 404 at submit time and
   * an omission from the picker (D154). Never expressible as a limit of zero:
   * the bounds above forbid one, precisely so that "not solvable in this
   * language" cannot be said as "0 ms".
   */
  allowed: z.boolean(),
});
export type ProblemLanguageLimitSettingDto = z.infer<typeof ProblemLanguageLimitSetting>;

/**
 * `GET /problems/{code}/language-limits` — everything the authoring form
 * needs and nothing the pupil's view already carries.
 *
 * Its own route rather than more fields on `ProblemDetail`: this is editor-only
 * (`ProblemDetail` is served to anyone who may see the problem at all), and
 * five rows of language defaults on every statement page for a question only
 * one screen asks is the payload argument `languageLimits` itself is on the
 * detail-not-the-summary for.
 */
export const ProblemLanguageLimitSettings = z.object({
  /**
   * The published revision's AUTHORED limits — what the multipliers multiply.
   * `null` for a problem with no published revision, exactly as
   * `ProblemDetail.languageLimits` is `[]` then: there is nothing to adjust,
   * and inventing a base would be a limit nobody wrote. The form still edits
   * the overrides in that state; it just cannot preview a result.
   */
  base: z.object({ timeMs: z.number().int(), memoryKb: z.number().int() }).nullable(),
  /**
   * One row per ACTIVE language, in `ProblemDetail.languageLimits`' order
   * (D158) so the form and the pupil's picker read the same way down.
   */
  languages: z.array(ProblemLanguageLimitSetting),
});
export type ProblemLanguageLimitSettingsDto = z.infer<typeof ProblemLanguageLimitSettings>;

/**
 * `PUT /problems/{code}/language-limits` — the WHOLE set, replacing whatever
 * is stored.
 *
 * A replacement rather than a patch, on `members`/`orgSlugs`' existing rule
 * (`ProblemAccessService.update`): the form renders every active language at
 * once, so it always knows the whole answer, and a partial write would leave
 * a setter no way to remove an override they can see on their screen.
 *
 * A row that inherits both columns and allows the language is byte-identical
 * to no row at all, and is stored as no row — see the route's description.
 */
export const UpdateProblemLanguageLimitsRequest = z.object({
  limits: z.array(
    ProblemLanguageLimitSetting.pick({
      languageKey: true,
      timeMultiplierPct: true,
      memoryExtraKb: true,
      allowed: true,
    }),
  ),
});
export type UpdateProblemLanguageLimitsRequestDto = z.infer<
  typeof UpdateProblemLanguageLimitsRequest
>;

export const ProblemDetail = ProblemSummary.extend({
  statement: z.string(),
  /**
   * One entry per ACTIVE language, in the order they were ADDED to this
   * deployment — what each of them is really given on this problem (D154).
   * Empty when the problem has no published revision, for the same reason
   * `timeMs`/`memoryKb` are null then: there are no authored limits to
   * adjust.
   *
   * **The order is part of the contract, because the FIRST entry is what the
   * submit box preselects** (D158). Ordered by `key` it began `c11`, so a
   * pupil who reached the submit box from a statement page was offered C11
   * and a C starter template on every problem on the site.
   *
   * On the detail and not the summary, on `testCount`'s rule in reverse: no
   * list row renders it, and a five-entry array per row would be payload on
   * every page of every search to answer a question only the submit box asks.
   */
  languageLimits: z.array(ProblemLanguageLimit),
  // On the detail, not the summary: `PATCH /problems/:code` answers with a
  // `ProblemDetail`, so without this the round-trip would be write-only —
  // a client could set the flag and never read back what it now is.
  sourceAccess: ProblemSourceAccess,
  testCount: z.number().int().nullable(),
  totalPoints: z.number().nullable(),
  checkerKind: z.string().nullable(),
  createdAt: Timestamp,
  // `members` is credit (spec §4.1): visible to anyone who may see the
  // problem at all, same as DMOJ's public authorship display. `orgSlugs` is
  // NOT symmetric with it — see `ProblemAccessService.loadMembersAndOrgs`'s
  // doc comment for why returning the full organization list to every
  // viewer would leak private organizations' names/existence.
  members: z.array(ProblemMember),
  orgSlugs: z.array(z.string()),
  /**
   * The editorial's Markdown, or `null` (D43). For a viewer who may not
   * edit this problem, `editorial !== null` is exactly `editorialAvailable`,
   * and `null`/`false` is ONE indistinguishable answer to three different
   * questions — the problem has no editorial, it has an unpublished draft,
   * or it has a published one this viewer may not read yet. Distinguishing
   * them would leak both a setter's work-in-progress and, during a contest,
   * the fact that a solution exists to be read.
   *
   * An **editor** (an author, a curator, an admin) additionally gets the
   * unpublished draft here — the edit form seeds its textarea from this
   * field, and a form that could not load what it is about to overwrite
   * would be a way to lose an editorial rather than a way to write one.
   */
  editorial: z.string().nullable(),
  /**
   * Whether this viewer may read a **published** editorial. For an editor
   * this is therefore the publish state itself (the edit form's toggle
   * seeds from it), and it is the one field on which `editorial` being
   * non-null does not imply `true`: an editor holding a draft reads
   * `{ editorial: "...", editorialAvailable: false }`.
   */
  editorialAvailable: z.boolean(),
  /**
   * The published revision's samples, in manifest order (D94). Empty — never
   * absent — for a problem with no published revision, for a package whose
   * tests are all scored, and for a package whose blob could not be read:
   * samples are a convenience on top of the statement, and a problem page
   * that 500s because a cache or a volume was unhappy would be a far worse
   * failure than a page whose example table is the only copy.
   *
   * Not masked by D35 like `tags` and `difficulty` are: a sample is part of
   * the problem, not a hint about it, and a contestant sitting the round is
   * exactly who needs it.
   */
  samples: z.array(ProblemSample),
  /**
   * The `version` of the revision that is currently published — the one every
   * new submission is graded against — or `null` when none is (D92).
   *
   * On the detail rather than the summary, unlike `testCount`/`tags`: no list
   * row renders it, so it would be payload on every page of every search to
   * answer a question only the problem's own page asks. `hasPublishedRevision`
   * stays exactly what it was and is not derived from this: it is the boolean
   * a list row does render, and removing it would make every caller compute
   * `publishedVersion !== null` instead.
   *
   * Nullable on the same rule as `timeMs`/`memoryKb`/`testCount`/`totalPoints`
   * — all five come from the join onto the PUBLISHED revision, so they are
   * `null` together or populated together, and a problem whose pointer is not
   * on a published revision reads as one that has never shipped rather than
   * quietly reporting an archived revision's number as live.
   *
   * The field's absence is what F-21's live probe reported as
   * `publishedVersion: null` for every problem on the stack: `jq` prints
   * `null` for a key that is not there, so a missing field and a null field
   * are one string on the wire. The detail genuinely could not answer "which
   * version is live" — only `GET /problems/{code}/revisions` could, and that
   * route is members-and-admins only.
   */
  publishedVersion: z.number().int().positive().nullable(),
  /**
   * What this caller must send back as `expectedVersion` to be sure their
   * PATCH replaces the state they were shown, and not somebody else's — D161.
   *
   * An opaque hash of the problem's **stored editable columns**: exactly the
   * fields `UpdateProblemRequest` can write, and nothing else. So publishing a
   * revision, adjusting a language's limits or grading a submission does not
   * move it, and two saves that produce the same state do not conflict.
   *
   * **`null` for a caller who may not edit this problem.** It is served on
   * `ContestDetail.canEdit`'s precedent — a fact about editing, answered by
   * the server rather than assembled by the client — and computing it costs a
   * query no pupil reading a statement should pay.
   */
  version: z.string().nullable(),
});
export type ProblemDetailDto = z.infer<typeof ProblemDetail>;

/**
 * `GET /problems/{code}/editorial`. A route of its own rather than only the
 * `ProblemDetail` field, because the editorial is the one part of a problem
 * a reader deliberately asks for — a spoiler is not something to ship with
 * every page load of the statement — and because 404 is the honest answer
 * to "show me the solution" when there is none to show, where a detail
 * response has to answer *something* about the problem regardless.
 */
export const EditorialResponse = z.object({ markdown: z.string() });
export type EditorialResponseDto = z.infer<typeof EditorialResponse>;

/** One bar of a histogram: the value, and how many submissions carry it. */
export const StatsBucket = z.object({ key: z.string(), count: z.number().int() });
export type StatsBucketDto = z.infer<typeof StatsBucket>;

/** One of the ten fastest accepted submissions (D49). */
export const FastestSubmission = z.object({
  submissionId: z.number().int(),
  username: z.string(),
  timeMs: z.number().int(),
  memoryKb: z.number().int().nullable(),
  createdAt: Timestamp,
});
export type FastestSubmissionDto = z.infer<typeof FastestSubmission>;

/**
 * `GET /problems/{code}/stats` — D49.
 *
 * Every field counts only submissions whose contest participation window has
 * **closed**, uniformly for every viewer (an admin included). A live room's
 * acceptance rate is a difficulty hint of the same family D35 withholds, and
 * a per-viewer answer would make the cache a per-viewer cache.
 */
export const ProblemStats = z.object({
  totalSubmissions: z.number().int(),
  attemptedUsers: z.number().int(),
  solvedUsers: z.number().int(),
  /**
   * Accepted submissions / total submissions — a *submission* rate, not a
   * people rate, which is what every judge means by the words and what the
   * verdict histogram beside it is a breakdown of. `null`, never `0`, when
   * there is nothing to divide: "nobody has tried" is not "nobody succeeded".
   */
  acceptanceRate: z.number().nullable(),
  /** Keyed by `Verdict`; a verdict nobody has scored is absent, not zero. */
  verdicts: z.array(StatsBucket),
  /** Keyed by the language's `key`, ordered by count then key. */
  languages: z.array(StatsBucket),
  /**
   * At most ten, one row per person — their own best — so one student's
   * resubmissions cannot fill the table. Ordered by `timeMs`, ties by id.
   * `submissionId` links to `GET /submissions/{id}`, which decides for
   * itself whether this viewer may open it: the statistics disclose that
   * somebody solved the problem and how fast, never their source.
   */
  fastest: z.array(FastestSubmission),
  /** The earliest accepted submission, or `null` if nobody has solved it. */
  firstSolver: z
    .object({ submissionId: z.number().int(), username: z.string(), createdAt: Timestamp })
    .nullable(),
});
export type ProblemStatsDto = z.infer<typeof ProblemStats>;

/**
 * The upper bound on a comment's body, in both the zod bound below and the
 * `problem_comments_body_len_ck` CHECK — 4000 chars is long enough for a real
 * discussion post and far below anything that hurts.
 */
export const COMMENT_BODY_MAX = 4000;

/**
 * One comment in a problem's discussion (D109).
 *
 * `body` and `author` are `null` **only on a tombstone** — a top-level
 * comment that was deleted but still anchors at least one visible reply, so
 * the thread does not lose its shape. Every non-deleted comment carries both,
 * and a deleted comment with no visible reply is omitted from the list
 * entirely rather than shown as a tombstone.
 *
 * `body` is the author's raw Markdown, rendered client-side through the same
 * DOMPurify path as the statement (`apps/web/src/markdown.ts`) — the API
 * never emits HTML for it.
 */
export const ProblemComment = z.object({
  id: z.number().int(),
  /** `null` for a top-level comment; the top-level comment's id for a reply. */
  parentId: z.number().int().nullable(),
  /** `null` on a tombstone; otherwise the author's username. */
  author: z.object({ username: z.string() }).nullable(),
  /** `null` on a tombstone; otherwise the raw Markdown body. */
  body: z.string().nullable(),
  createdAt: Timestamp,
  /** When the author last edited it, or `null` if never. */
  editedAt: Timestamp.nullable(),
  /** When it was soft-deleted, or `null`. Non-null iff this is a tombstone. */
  deletedAt: Timestamp.nullable(),
});
export type ProblemCommentDto = z.infer<typeof ProblemComment>;

/**
 * A top-level comment together with its one level of replies (D109 — a reply
 * can never itself be replied to). `replies` are in id order, oldest first,
 * and a deleted reply is omitted rather than shown as a tombstone: a reply
 * anchors nothing below it, so there is no thread shape to preserve.
 */
export const ProblemCommentThread = ProblemComment.extend({
  replies: z.array(ProblemComment),
});
export type ProblemCommentThreadDto = z.infer<typeof ProblemCommentThread>;

/**
 * A page of discussion threads.
 *
 * `hiddenDuringContest` deliberately breaks D35's "blank, never signalled"
 * rule, and D109 justifies the exception: the whole page is empty and the
 * flag is `true` for a viewer sitting a running contest that uses this
 * problem. It discloses nothing the viewer does not already know — they
 * joined the contest and can see it contains this problem (that is what let
 * them open the statement at all) — and the brief requires the UI to show a
 * note rather than an indistinguishable empty thread.
 */
export const ProblemCommentPage = z.object({
  items: z.array(ProblemCommentThread),
  nextCursor: z.string().nullable(),
  hiddenDuringContest: z.boolean(),
});
export type ProblemCommentPageDto = z.infer<typeof ProblemCommentPage>;

export const CreateCommentRequest = z
  .object({
    body: z.string().min(1).max(COMMENT_BODY_MAX),
    /**
     * Present to post a reply, absent for a top-level comment. The named
     * comment must itself be top-level and belong to this problem, or the
     * request is 422 — a reply-to-a-reply is not a state the one-level thread
     * has a meaning for.
     */
    parentId: z.number().int().positive().optional(),
  })
  .strict();
export type CreateCommentRequestDto = z.infer<typeof CreateCommentRequest>;

export const UpdateCommentRequest = z
  .object({ body: z.string().min(1).max(COMMENT_BODY_MAX) })
  .strict();
export type UpdateCommentRequestDto = z.infer<typeof UpdateCommentRequest>;

/**
 * Two schemas for the `{id}` path param, mirroring `RevisionVersionParam`:
 * `z.coerce.number()` alone documents a path parameter as nullable, which
 * OpenAPI 3.1 forbids (`openapi-path-params.spec.ts` enforces this repo-wide).
 * The plain schema is registered; the coerced one is what parses the segment.
 */
const CommentIdParamSchema = z.number().int().positive();
export const CommentIdParam = z.coerce.number().pipe(CommentIdParamSchema);
export type CommentIdParamDto = z.infer<typeof CommentIdParam>;

const ProblemCodeAndCommentParam = z.object({ code: z.string(), id: CommentIdParamSchema });

export const RevisionSummary = z.object({
  id: z.number().int(),
  version: z.number().int(),
  state: z.enum(['draft', 'published', 'archived']),
  packageHash: z.string(),
  notes: z.string().nullable(),
  timeMs: z.number().int(),
  memoryKb: z.number().int(),
  testCount: z.number().int(),
  totalPoints: z.number(),
  checkerKind: z.string(),
  createdBy: z.number().int(),
  createdAt: Timestamp,
});
export type RevisionSummaryDto = z.infer<typeof RevisionSummary>;

export const RevisionList = z.array(RevisionSummary);
export type RevisionListDto = z.infer<typeof RevisionList>;

export const RevisionVersionResponse = z.object({ version: z.number().int() });
export type RevisionVersionResponseDto = z.infer<typeof RevisionVersionResponse>;

/**
 * Two schemas, deliberately — mirrors `submissions.ts`'s `SubmissionIdParam`:
 * `z.coerce.number()` alone documents an `in: "path"` OpenAPI parameter as
 * `{"required": false, "schema": {"type": ["integer", "null"]}}` under zod v4
 * + zod-to-openapi v9, which is illegal for a path parameter under OpenAPI
 * 3.1 (`openapi-path-params.spec.ts` enforces this repo-wide). The plain,
 * uncoerced schema is what gets registered in the OpenAPI document; the
 * coerced one is what `ZodValidationPipe` actually parses the route
 * segment's raw string with.
 */
const RevisionVersionParamSchema = z.number().int().positive();
export const RevisionVersionParam = z.coerce.number().pipe(RevisionVersionParamSchema);
export type RevisionVersionParamDto = z.infer<typeof RevisionVersionParam>;

const ProblemCodeParam = z.object({ code: z.string() });
const ProblemCodeAndVersionParam = z.object({
  code: z.string(),
  version: RevisionVersionParamSchema,
});

const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const FORBIDDEN = {
  description: 'Signed in, but not permitted to perform this action on this problem',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const PROBLEM_NOT_FOUND = {
  description: 'No such problem, or one the caller may not see — the two are indistinguishable',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const VALIDATION_FAILED = {
  description: 'The request failed validation',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'get',
  path: '/problems',
  tags: ['Problems'],
  summary:
    'Problems visible to the caller, filtered by search text, tags, difficulty and the caller’s own status',
  description:
    'The `status` filter (`solved` | `attempted` | `unsolved`) is per-viewer and authenticated only: an ' +
    'anonymous caller who sends it is answered 422 `status_requires_auth` (D125). "solved" needs an `AC` ' +
    'whose contest window has closed (D49), so an in-contest `AC` counts as "attempted" until the round ends.',
  request: { query: ProblemListQuery },
  responses: {
    200: {
      description: 'A page of problems',
      content: { 'application/json': { schema: ProblemPage } },
    },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}',
  tags: ['Problems'],
  summary: 'A single problem visible to the caller',
  request: { params: ProblemCodeParam },
  responses: {
    200: { description: 'The problem', content: { 'application/json': { schema: ProblemDetail } } },
    404: PROBLEM_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}/statement.pdf',
  tags: ['Problems'],
  summary: 'The statement as a printable PDF',
  request: { params: ProblemCodeParam },
  responses: {
    200: {
      description: 'The rendered statement',
      content: { 'application/pdf': { schema: z.string() } },
    },
    404: PROBLEM_NOT_FOUND,
    501: {
      description: 'This server has no typst binary configured (`statement_pdf_unavailable`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/problems/{code}/clone',
  tags: ['Problems'],
  summary: 'Create a new problem from an existing one',
  description:
    'Copies the statement, the editorial (unpublished), the tags, the difficulty and the current ' +
    "published revision's package — as revision 1 of the new problem, in `draft` state. The copy is " +
    'private and its only member is the caller. Nothing about how the source was USED is copied: no ' +
    'submissions, no statistics, no organization shares, no membership. Cloning requires the right ' +
    'to EDIT the source (it carries an unpublished editorial and the whole test set) as well as the ' +
    'right to create problems.',
  request: {
    params: ProblemCodeParam,
    body: { content: { 'application/json': { schema: CloneProblemRequest } } },
  },
  responses: {
    201: {
      description: 'The new problem',
      content: { 'application/json': { schema: ProblemDetail } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: PROBLEM_NOT_FOUND,
    409: {
      description: 'A problem already has that code (`problem_code_taken`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'post',
  path: '/problems',
  tags: ['Problems'],
  summary: 'Create a problem',
  request: { body: { content: { 'application/json': { schema: CreateProblemRequest } } } },
  responses: {
    201: {
      description: 'The created problem',
      content: { 'application/json': { schema: ProblemDetail } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    409: {
      description: 'That problem code is already taken',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/problems/{code}',
  tags: ['Problems'],
  summary:
    "Update a problem's name, statement, visibility, sharing, membership, tags, difficulty or editorial",
  request: {
    params: ProblemCodeParam,
    body: { content: { 'application/json': { schema: UpdateProblemRequest } } },
  },
  responses: {
    200: {
      description: 'The updated problem',
      content: { 'application/json': { schema: ProblemDetail } },
    },
    400: {
      description: 'The patch carried `code` (immutable) or would leave the problem with no author',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: PROBLEM_NOT_FOUND,
    422: {
      description:
        'The request failed validation, named a tag slug that does not exist, or asked to publish ' +
        'an empty editorial (`problem_editorial_empty`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}/language-limits',
  tags: ['Problems'],
  summary: "The per-language limit overrides, as the problem's editors may edit them (D159)",
  description:
    'Editor-only, and 404 rather than 403 for a problem the caller cannot SEE at all — the same ' +
    'order `PATCH /problems/{code}` applies. Carries the INPUTS (each language\u2019s default ' +
    'multiplier and memory floor, this problem\u2019s override or `null` for "inherit", and ' +
    'whether the language is allowed) plus the published revision\u2019s authored limits, so an ' +
    'editing form can show the resulting limits for a value that has been typed and not yet ' +
    'saved. `GET /problems/{code}` carries the RESOLVED limits a pupil sees; this is its twin, ' +
    'not a replacement for it.',
  request: { params: ProblemCodeParam },
  responses: {
    200: {
      description: 'The overrides and the defaults they resolve over',
      content: { 'application/json': { schema: ProblemLanguageLimitSettings } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: PROBLEM_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'put',
  path: '/problems/{code}/language-limits',
  tags: ['Problems'],
  summary: "Replace this problem's per-language limit overrides (D159)",
  description:
    'The WHOLE set, replacing whatever is stored — the same rule `members` and `orgSlugs` follow ' +
    'on `PATCH /problems/{code}`. A row that inherits both columns (`null`, `null`) and allows ' +
    'the language is byte-identical to having no row, and is stored as none, so a set that says ' +
    'nothing about any language clears every override.\n\n' +
    '`null` is "inherit this column from the language default", NOT zero: an override may pin ' +
    'the time and keep the interpreter\u2019s memory floor (D154). A multiplier is bounded ' +
    'below by 100 % and a memory addend by 0 KB, because an adjustment may never take away from ' +
    'what the setter authored — "this problem cannot be solved in this language" is ' +
    '`allowed: false`, which is a 404 at submit time, never a limit of zero presented as a TLE ' +
    '(D159). The same bounds are a CHECK in the database, so a caller that bypasses this route ' +
    'is refused too.',
  request: {
    params: ProblemCodeParam,
    body: { content: { 'application/json': { schema: UpdateProblemLanguageLimitsRequest } } },
  },
  responses: {
    200: {
      description: 'The stored overrides, re-read',
      content: { 'application/json': { schema: ProblemLanguageLimitSettings } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: PROBLEM_NOT_FOUND,
    422: {
      description:
        'The request failed validation (a bound, or a `languageKey` that is unknown, inactive ' +
        'or named twice)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}/editorial',
  tags: ['Problems'],
  summary: "The problem's editorial, when the caller may read it",
  request: { params: ProblemCodeParam },
  responses: {
    200: {
      description: 'The editorial as Markdown',
      content: { 'application/json': { schema: EditorialResponse } },
    },
    404: {
      description:
        'No such problem, one the caller may not see, or an editorial that is absent, unpublished, ' +
        'or withheld while the caller sits a contest using this problem (D43) — all indistinguishable',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}/revisions',
  tags: ['Problems'],
  summary: "A problem's revision history — draft, published and archived alike",
  request: { params: ProblemCodeParam },
  responses: {
    200: {
      description: 'Every revision, oldest first',
      content: { 'application/json': { schema: RevisionList } },
    },
    404: {
      description:
        'No such problem, or the caller is not a member (any role) or admin — unlike GET /problems/{code}, ' +
        'public or org visibility alone is not enough to see revision history',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/problems/{code}/revisions',
  tags: ['Problems'],
  summary: 'Attach an already-uploaded package as a new draft revision',
  request: {
    params: ProblemCodeParam,
    body: { content: { 'application/json': { schema: AttachRevisionRequest } } },
  },
  responses: {
    201: {
      description: 'The new draft revision was created',
      content: { 'application/json': { schema: RevisionVersionResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such problem, or no such package',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: {
      description: 'The package manifest is invalid, or its paths collide',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/problems/{code}/revisions/{version}/publish',
  tags: ['Problems'],
  summary: 'Publish a draft or archived revision, archiving whatever was previously published',
  request: { params: ProblemCodeAndVersionParam },
  responses: {
    200: {
      description: 'The revision is now published',
      content: { 'application/json': { schema: RevisionVersionResponse } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description: 'No such problem, or no such revision version',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}/stats',
  tags: ['Problems'],
  summary: "The problem's submission statistics",
  description:
    'Visibility is exactly `GET /problems/{code}`. Submissions belonging to a contest ' +
    'participation whose window is still open are excluded from every field, for every viewer ' +
    '(D49) — and a viewer sitting a running contest that uses this problem is served the empty ' +
    'shape, the same one a problem nobody has attempted returns (D35).',
  request: { params: ProblemCodeParam },
  responses: {
    200: {
      description: 'The statistics',
      content: { 'application/json': { schema: ProblemStats } },
    },
    404: PROBLEM_NOT_FOUND,
  },
});

registry.registerPath({
  method: 'get',
  path: '/problems/{code}/comments',
  tags: ['Problems'],
  summary: "The problem's discussion (D109)",
  description:
    'Visibility is exactly `GET /problems/{code}`. A viewer sitting a running contest that uses ' +
    'this problem is served an empty page with `hiddenDuringContest: true` (D109) — a discussion ' +
    'can leak the solution, so it is withheld until the contest is over; organisers and admins are ' +
    'unaffected. A deleted comment appears as a tombstone only while it anchors a visible reply.',
  request: { params: ProblemCodeParam, query: PaginationQuery },
  responses: {
    200: {
      description: 'A page of discussion threads',
      content: { 'application/json': { schema: ProblemCommentPage } },
    },
    404: PROBLEM_NOT_FOUND,
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'post',
  path: '/problems/{code}/comments',
  tags: ['Problems'],
  summary: 'Post a comment or a reply on a problem',
  description:
    'Authenticated. Rate-limited to 10 per user per hour (429 `comment_rate_limited`, with ' +
    '`Retry-After`). Withheld exactly as the read is while the caller sits a running contest that ' +
    'uses this problem (D109). A `parentId` must name a top-level, non-deleted comment on this ' +
    'problem, or the request is 422.',
  request: {
    params: ProblemCodeParam,
    body: { content: { 'application/json': { schema: CreateCommentRequest } } },
  },
  responses: {
    201: {
      description: 'The created comment',
      content: { 'application/json': { schema: ProblemComment } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: PROBLEM_NOT_FOUND,
    422: VALIDATION_FAILED,
    429: {
      description: 'Too many comments this hour (`comment_rate_limited`)',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/problems/{code}/comments/{id}',
  tags: ['Problems'],
  summary: 'Edit one of your own comments',
  request: {
    params: ProblemCodeAndCommentParam,
    body: { content: { 'application/json': { schema: UpdateCommentRequest } } },
  },
  responses: {
    200: {
      description: 'The edited comment',
      content: { 'application/json': { schema: ProblemComment } },
    },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description:
        'No such problem, no such comment, or one the caller may not see — indistinguishable',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
    422: VALIDATION_FAILED,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/problems/{code}/comments/{id}',
  tags: ['Problems'],
  summary: 'Soft-delete a comment (author or admin)',
  request: { params: ProblemCodeAndCommentParam },
  responses: {
    204: { description: 'The comment was soft-deleted' },
    401: NOT_SIGNED_IN,
    403: FORBIDDEN,
    404: {
      description:
        'No such problem, no such comment, or one the caller may not see — indistinguishable',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

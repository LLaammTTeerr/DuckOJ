/**
 * The results exports (D71): who may take them, and what goes in them.
 *
 * **One gate, for all three routes: `canRunContest`.** The contest's creator
 * or a global admin — the same predicate `canEdit` reports and every contest
 * write already refuses on. Nobody else, at any hour, including after the
 * contest has ended.
 *
 * That is stricter than "after `end_time`, anyone" on purpose, and D22 is
 * why. Every one of these documents is the LIVE board: the export folds the
 * board the privileged view sees, with no freeze applied, because a results
 * sheet that hides the last hour of a contest is not a results sheet. Handing
 * that to a caller who is not running the contest would publish, through a
 * `.csv`, exactly what `GET /contests/{key}/scoreboard` spends D22 and D23
 * hiding. So the gate is the PERSON, not the clock, and the "only after the
 * end" half of the requirement lives where it belongs — in the web UI, which
 * offers the links once the contest is over.
 *
 * Refusal is 403 `contest_forbidden`, not 404: `loadVisible` has already
 * shown this caller the contest, so there is no existence left for the
 * 404-over-403 rule to protect. Same shape `answerClarification` and
 * `announce` already use for the same distinction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import type { FormatData, IcpcFormatData } from '@duckoj/contest-formats';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from '../authz/actor.js';
import { ContestAccessService, canRunContest } from '../authz/contest.access.js';
import { loadParticipantOrgs } from '../authz/participant-orgs.js';
import {
  DEFAULT_ISSUER,
  certificatesToTypst,
  standingsToTypst,
  type ResultCell,
  type ResultRow,
  type ResultsInput,
} from '../statements/results.js';
import { resultsCsv } from './results-csv.js';

/** Which certificates to print. Exactly one of the two is set (the contract). */
export interface CertificateScope {
  top?: number | undefined;
  username?: string | undefined;
}

const FORBIDDEN = new AppError(
  403,
  'contest_forbidden',
  'Only the people who run this contest may export its results.',
);

/**
 * `format_data` carries `tries` for `icpc` and for nothing else. `null` means
 * "this format does not count attempts", which the CSV prints as an empty
 * cell — a `0` would claim an IOI competitor never submitted.
 */
function attemptsOf(data: FormatData | IcpcFormatData): number | null {
  return 'tries' in data ? data.tries : null;
}

/**
 * Who gets a certificate.
 *
 * **A disqualified row never does, and neither does a virtual replay.** The
 * results sheet keeps both — the record of what happened is the row (D37) —
 * but a certificate is not a record, it is an award, and awarding one for a
 * replay of a contest already run, or to somebody expelled from it, is the
 * one thing this endpoint must not print. `top=N` counts down the ranking
 * AFTER that exclusion, so `top=3` is three certificates and not two plus a
 * gap.
 *
 * **A tie is never cut through (D74).** The board ranks in competition style
 * — equal score and equal penalty share a rank, and the rank after a group
 * of k jumps by k — so `slice(0, top)` handed a certificate to one of two
 * competitors ranked equal third and nothing to the other, on the order the
 * scoreboard happened to break the tie in (a tiebreaker column no printed
 * result mentions). The boundary is therefore a RANK, not a count: everybody
 * at or above the rank the Nth eligible row holds. `top=3` over ranks
 * 1, 2, 3, 3 is four certificates, and the fourth is not a mistake — it says
 * "third", which is what the board says.
 *
 * The rank printed is the row's own rank from the live board, never its
 * index in this filtered list: a competitor's certificate says where they
 * finished, and the board is what says it.
 *
 * Exported for its own test: the tie is a property of this selection and
 * nothing downstream of it can see one.
 */
export function selectCertified(rows: ResultRow[], scope: CertificateScope): ResultRow[] {
  const eligible = rows.filter((row) => !row.disqualified && row.virtual === 0);
  if (scope.username !== undefined) {
    const wanted = scope.username.toLowerCase();
    const found = eligible.find((row) => row.username.toLowerCase() === wanted);
    if (!found) {
      // 404, not 403: this is a row that is not there — an unranked, a
      // disqualified or a virtual-only entrant — and naming which of the
      // three would report a disqualification to whoever asked. The
      // organiser can already read all three from the results sheet.
      throw new AppError(
        404,
        'contest_participant_not_found',
        'No certifiable result for that participant in this contest.',
      );
    }
    return [found];
  }
  const boundary = scope.top === undefined ? undefined : eligible[scope.top - 1];
  // Fewer eligible rows than were asked for: every one of them, as before.
  if (boundary === undefined) return eligible;
  return eligible.filter((row) => row.rank <= boundary.rank);
}

@Injectable()
export class ContestResultsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ContestAccessService) private readonly contests: ContestAccessService,
  ) {}

  /** The results sheet as Excel opens it — BOM, CRLF, one row per ranking row. */
  async resultsCsv(actor: Actor, key: string): Promise<{ contestKey: string; csv: string }> {
    const { input } = await this.buildResults(actor, key);
    return { contestKey: input.contestKey, csv: resultsCsv(input) };
  }

  /** The final standings as a landscape typst document, ready to compile. */
  async standingsDocument(
    actor: Actor,
    key: string,
  ): Promise<{ contestId: number; contestKey: string; document: string }> {
    const { contestId, input } = await this.buildResults(actor, key);
    return { contestId, contestKey: input.contestKey, document: standingsToTypst(input) };
  }

  /**
   * The selected certificates as one typst document.
   *
   * The SELECTION is part of the document — `top=3` and `top=5` build
   * different sources — so the content-addressed cache separates them by
   * construction, with no scope in the key.
   */
  async certificatesDocument(
    actor: Actor,
    key: string,
    scope: CertificateScope,
  ): Promise<{ contestId: number; contestKey: string; document: string }> {
    const { contestId, input } = await this.buildResults(actor, key);
    // `loadOrgs`, not `getVisible`: `buildResults` has already resolved and
    // gated this contest, and `getVisible` would resolve it a second time —
    // the contest row, its problem rows and their published revisions — to
    // reach the two strings on the signature line.
    const orgs = (await this.contests.loadOrgs([contestId])).get(contestId) ?? [];
    return {
      contestId,
      contestKey: input.contestKey,
      document: certificatesToTypst({
        ...input,
        // The contest's own organizations sign it (D56 — a contest's orgs are
        // the schools it belongs to), and the site itself when it has none.
        // Several orgs are joined rather than one picked: a contest run by
        // two schools together is signed by both.
        issuer: orgs.length === 0 ? DEFAULT_ISSUER : orgs.map((org) => org.name).join(' · '),
        rows: this.selectCertified(input.rows, scope),
      }),
    };
  }

  private selectCertified(rows: ResultRow[], scope: CertificateScope): ResultRow[] {
    return selectCertified(rows, scope);
  }

  /**
   * The whole export, assembled once: the gate, the live board, and the two
   * columns the board does not carry (display name, the competitor's own
   * organizations).
   *
   * `getScoreboardCached` is what folds the board, so the export rides D25's
   * 2 s cache rather than folding a second copy — and it hands a privileged
   * caller the UNFROZEN board by being handed no clock at all (D22), which is
   * the property this whole feature depends on.
   */
  private async buildResults(
    actor: Actor,
    key: string,
  ): Promise<{ contestId: number; input: ResultsInput }> {
    const contest = await this.contests.loadVisible(actor, key);
    if (!canRunContest(actor, contest)) throw FORBIDDEN;
    const board = await this.contests.getScoreboard(actor, key);

    const usernames = board.ranking.map((row) => row.participant);
    const [displayNames, orgsByUsername] = await Promise.all([
      this.loadDisplayNames(usernames),
      loadParticipantOrgs(this.db, contest.id),
    ]);

    return {
      contestId: contest.id,
      input: {
        contestKey: contest.key,
        contestName: contest.name,
        startTime: contest.startTime,
        endTime: contest.endTime,
        pointsPrecision: contest.pointsPrecision,
        problems: board.problems.map((problem) => ({ code: problem.code, label: problem.label })),
        rows: board.ranking.map((row) => ({
          rank: row.rank,
          username: row.participant,
          // The username is the fallback, never an empty column: `display_name`
          // is NOT NULL in the schema, so this only fires for a ranking row
          // whose account has since been deleted.
          displayName: displayNames.get(row.participant) ?? row.participant,
          orgs: (orgsByUsername.get(row.participant) ?? []).map((org) => org.name),
          virtual: row.virtual,
          disqualified: row.is_disqualified,
          total: row.score,
          penalty: row.cumtime,
          cells: mapCells(row.format_data),
        })),
        // Only the certificates use it, and they overwrite it with the
        // contest's organizations. A required field with a real default beats
        // an optional one nobody remembers to set.
        issuer: DEFAULT_ISSUER,
      },
    };
  }

  /**
   * Username → display name, in ONE query for the whole board.
   *
   * `users` is in `@duckoj/db`'s unguarded identity schema, so this service
   * may read it directly; the organizations beside it are guarded and go
   * through `loadParticipantOrgs` instead.
   */
  private async loadDisplayNames(usernames: string[]): Promise<Map<string, string>> {
    if (usernames.length === 0) return new Map();
    const rows = await this.db
      .select({ username: schema.users.username, displayName: schema.users.displayName })
      .from(schema.users)
      .where(inArray(schema.users.username, usernames));
    return new Map(rows.map((row) => [row.username, row.displayName]));
  }
}

/** `format_data` → the export's cells, keyed by problem code exactly as it is. */
function mapCells(
  formatData: Record<string, FormatData | IcpcFormatData>,
): Record<string, ResultCell> {
  const cells: Record<string, ResultCell> = {};
  for (const [code, data] of Object.entries(formatData)) {
    cells[code] = { points: data.points, attempts: attemptsOf(data), timeSeconds: data.time };
  }
  return cells;
}

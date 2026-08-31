/**
 * B-22 / D113 — the team seam on the My-progress page.
 *
 * `ProgressService.upcomingContests` keyed the "contests you are sitting" list
 * on `contest_participations.user_id = you`. In a TEAM contest (D99) that row
 * belongs to whichever member pressed Join, so every OTHER member's progress
 * page was empty of the very round they are competing in. The fix routes the
 * read through `actingParticipationWhere` (D101/D113), so it lists the contest
 * for the whole roster.
 *
 * The `member` assertion below is red against the pre-fix `eq(userId, …)`
 * predicate; the `captain` one is the control that was always green.
 */
import { describe, expect, it } from 'vitest';
import {
  contestParticipations,
  contests,
  organizations,
  teamMembers,
  teams,
} from '@duckoj/db/guarded';
import { ProgressService } from '../src/authz/progress.access.js';
import type { Actor } from '../src/authz/actor.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

const HOUR = 60 * 60 * 1000;

function actor(userId: number): Actor {
  return { userId, globalRole: 'user', via: 'session', scopes: [] };
}

describe('team seam: My-progress lists the round for a NON-captain member (D113)', () => {
  it('shows the ongoing team contest to every member, not the captain alone', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'seam-owner', 'admin');
        const captain = await insertUser(db, 'seam-captain');
        const member = await insertUser(db, 'seam-member');

        const [org] = await db
          .insert(organizations)
          .values({ slug: 'seam-school', name: 'Seam School', visibility: 'public' })
          .returning({ id: organizations.id });
        const [team] = await db
          .insert(teams)
          .values({ orgId: org!.id, slug: 'seam-team', name: 'Đội Seam', createdBy: owner.id })
          .returning({ id: teams.id });
        await db.insert(teamMembers).values([
          { teamId: team!.id, userId: captain.id },
          { teamId: team!.id, userId: member.id },
        ]);

        const now = Date.now();
        const [contest] = await db
          .insert(contests)
          .values({
            key: 'seam-round',
            name: 'Vòng Seam',
            startTime: new Date(now - HOUR),
            endTime: new Date(now + 3 * HOUR),
            format: 'icpc',
            visibility: 'public',
            participationMode: 'team',
            maxTeamSize: 3,
            createdBy: owner.id,
          })
          .returning({ id: contests.id });

        // ONE participation for the team, held by the captain (D99), team_id set.
        await db.insert(contestParticipations).values({
          contestId: contest!.id,
          userId: captain.id,
          teamId: team!.id,
          virtual: 0,
          startTime: new Date(now - HOUR),
        });

        const progress = app.get(ProgressService);
        const captainKeys = (await progress.myProgress(actor(captain.id))).upcomingContests.map(
          (c) => c.key,
        );
        const memberKeys = (await progress.myProgress(actor(member.id))).upcomingContests.map(
          (c) => c.key,
        );

        // The control: the row-holder always saw it.
        expect(captainKeys).toContain('seam-round');
        // The regression: keyed on user_id this was empty for the member.
        expect(memberKeys).toContain('seam-round');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

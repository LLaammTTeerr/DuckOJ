/**
 * The ruling this file exists to prove: **a teacher types `nguyen` and finds
 * `Nguyễn`** (D185).
 *
 * Vietnamese is written with a diacritic on nearly every syllable and typed,
 * most of the time, without any of them — a school computer's keyboard layout,
 * a phone in a hurry, a teacher who knows the pupil's name but not which of
 * `Ước`/`Uớc`/`Uốc` the account was created with. A search that made the
 * reader reproduce the accents would answer only for people who already know
 * exactly how the row was spelled, which is nobody who needs to search. So the
 * fold is applied to BOTH sides and every case below is a real Vietnamese
 * name, never an ASCII placeholder.
 *
 * The second half of the ruling is the WORD prefix. Vietnamese puts the family
 * name first and the given name last, and a person is called by the last word:
 * *Nguyễn Văn An* is "An" to their teacher and to the register. A whole-string
 * prefix cannot find him — which is why `finds a pupil by the given name they
 * are actually called by` is here, and why the case beside it pins that a
 * match on the MIDDLE of a syllable is still refused (`an` must not drag in
 * `Hoàng`, `Lan`, `Thanh` and `Trang`, which is a whole province of noise).
 *
 * Every assertion runs over HTTP against the real controller and the real
 * Postgres, because the fold is a stored generated column and a unit test of
 * a TypeScript function would prove nothing about it at all.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Agent as SupertestAgent } from 'supertest';
import { organizations, orgMembers } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

const SLUG = 'thpt-chuyen-le-hong-phong';

/**
 * A class list a province would recognise. The usernames are the shape D61's
 * bulk import mints — a prefix and a number, unreadable on their own — which
 * is the whole reason `display_name` has to be searchable and, since D185,
 * served on the roster row.
 */
const PUPILS: { username: string; displayName: string }[] = [
  { username: 'hs000001', displayName: 'Nguyễn Văn An' },
  { username: 'hs000002', displayName: 'Nguyễn Thị Bình' },
  { username: 'hs000003', displayName: 'Trần Thanh Hà' },
  { username: 'hs000004', displayName: 'Hoàng Thị Lan' },
  { username: 'hs000005', displayName: 'Đỗ Hữu Ước' },
  { username: 'hs000006', displayName: 'Lê Ngọc Trang' },
  { username: 'hs000007', displayName: 'Phạm Đình Dũng' },
  // A username with the name inside it, hyphen-separated: the fold turns
  // `-`, `_` and `.` into spaces, so every part of it is a word.
  { username: 'gv-nguyen-van-an', displayName: 'Giáo viên chủ nhiệm' },
];

async function seedPupils(db: Db): Promise<void> {
  await db.insert(schema.users).values(
    PUPILS.map((p) => ({
      username: p.username,
      email: `${p.username}@truong.test`,
      passwordHash: 'x',
      displayName: p.displayName,
    })),
  );
}

/**
 * The display names `GET /users?q=` answers with, in the order served.
 *
 * **Signed in, since D188.** This helper used to issue the request with no
 * credential at all, because the route was `@Public()`; the list now requires
 * an actor. The search itself is unchanged — D185's fold is not a privilege
 * and a session grants no extra row — so every expectation below is the one
 * F-51 wrote, asked by a teacher who is logged in, which is who asks it.
 */
async function search(agent: SupertestAgent, q: string): Promise<string[]> {
  const res = await agent.get(`/api/v1/users?limit=50&q=${encodeURIComponent(q)}`).send();
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as { username: string; displayName: string }[]).map((u) => u.displayName);
}

/**
 * A signed-in teacher, which is what `GET /users` now takes (D188).
 *
 * The usernames passed here are deliberately `kiemtra*` — no word of them is
 * a prefix of `nguyen`, `an`, `do`, `dinh` or `uoc`. The observer is a row in
 * `users` like any other, so a name that matched would appear in the very
 * result it was created to read, and every expectation below would be one
 * longer for a reason that has nothing to do with the fold.
 */
async function teacher(app: Awaited<ReturnType<typeof buildApp>>, db: Db, username: string) {
  const agent = request.agent(app.getHttpServer());
  await registerAndLogin(agent, username);
  await giveStanding(db, username);
  return agent;
}

/**
 * A role in a school — which is what the word "teacher" in this file has always
 * meant, and what **D197** now requires before the display name is in the
 * haystack at all.
 *
 * Under `NAME_DISCLOSURE`'s default rung a reader with no standing in any
 * organization searches the folded USERNAME alone: D185's fold still applies to
 * it (`nguyen` still finds `gv-nguyen-van-an`), but a `q` matched against a name
 * that reader may not be SHOWN would confirm it one prefix at a time — the
 * oracle D191 closed for an anonymous roster reader, reopened for a signed-in
 * one. The case where the searcher has no standing is not lost; it moved to
 * `name-disclosure.spec.ts`, which asserts both halves of it.
 *
 * The organization is a bare row, not one of the schools below: standing is
 * "a role in ANY organization", never "an organization shared with the person
 * you are looking at" (D197 argues that alternative and why it lost).
 */
async function giveStanding(db: Db, username: string): Promise<void> {
  const [org] = await db
    .insert(organizations)
    .values({
      slug: `phong-gd-${username}`,
      name: 'Phòng Giáo dục',
      visibility: 'private',
    })
    .returning({ id: organizations.id });
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  await db.insert(orgMembers).values({ orgId: org!.id, userId: user!.id, role: 'member' });
}

describe('GET /users?q= — Vietnamese names, typed the way people type them (D185)', () => {
  it('finds Nguyễn from `nguyen`, and from `Nguyễn`, and from `NGUYEN`', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedPupils(db);
        const gv = await teacher(app, db, 'kiemtramot');
        // The ruling itself. Unaccented in, accented out. The third row is
        // the form teacher, matched on the `nguyen` inside the hyphenated
        // username `gv-nguyen-van-an` — the same word rule, applied to the
        // half of an account a bulk import chose.
        const expected = ['Nguyễn Văn An', 'Nguyễn Thị Bình', 'Giáo viên chủ nhiệm'];
        expect(await search(gv, 'nguyen')).toEqual(expected);
        // Folding BOTH sides is what makes the accented query work too: a
        // reader with a Vietnamese keyboard must not be punished for using it.
        expect(await search(gv, 'Nguyễn')).toEqual(expected);
        // And case, which is the same fold's first step.
        expect(await search(gv, 'NGUYEN')).toEqual(expected);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('finds a pupil by the given name they are actually called by, and not by a syllable inside another word', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedPupils(db);
        const gv = await teacher(app, db, 'kiemtrahai');
        // `An` is the LAST word of `Nguyễn Văn An`. A string prefix would
        // have answered nothing here, which is the failure this rules out.
        // The teacher's own account matches too, on the `an` at the end of
        // its hyphenated username.
        expect(await search(gv, 'an')).toEqual(['Nguyễn Văn An', 'Giáo viên chủ nhiệm']);
        // And NOT `Hoàng`, `Lan`, `Thanh` or `Trang`: a substring match would
        // return all four and call it an answer.
        expect(await search(gv, 'an')).not.toContain('Hoàng Thị Lan');
        expect(await search(gv, 'an')).not.toContain('Lê Ngọc Trang');
        expect(await search(gv, 'an')).not.toContain('Trần Thanh Hà');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('folds `đ`, which no amount of unicode decomposition would have', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedPupils(db);
        const gv = await teacher(app, db, 'kiemtraba');
        // `đ` is a letter with a STROKE, not a letter with a mark: NFD leaves
        // it exactly as it was, so it is mapped by hand in `searchFold`. Miss
        // that and every Đỗ, Đặng, Đinh and Dũng in the province is unfindable
        // by a keyboard that cannot type it.
        expect(await search(gv, 'do')).toEqual(['Đỗ Hữu Ước']);
        expect(await search(gv, 'dinh')).toEqual(['Phạm Đình Dũng']);
        // Two marks on one vowel — `ư` + horn, then the acute — both peeled.
        expect(await search(gv, 'uoc')).toEqual(['Đỗ Hữu Ước']);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

it('changes WHICH ROWS come back and never which fields — and the fold column stays server-side', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedPupils(db);
        // D26, checked rather than assumed. The question this case answers is
        // whether `q` adds a FIELD — it changes which rows come back, and the
        // fold column must never reach the wire.
        //
        // **The comparison is now made SIGNED IN, and that is the D188 change
        // visible from here.** F-51 asked it anonymously, and asserted at the
        // end that an anonymous caller and a signed-in one got byte-identical
        // results — true then, because the route was `@Public()`, and
        // deliberately no longer true: the anonymous half of that pair is now
        // a 401, which `user-list-enumeration.spec.ts` is what pins. The
        // disclosure property itself is unchanged and still checked here.
        const gv = await teacher(app, db, 'kiemtranam');
        const all = await gv.get('/api/v1/users?limit=50').send();
        const some = await gv.get('/api/v1/users?limit=50&q=nguyen').send();
        expect(all.status).toBe(200);
        expect(some.status).toBe(200);

        // Same shape, fewer rows.
        expect(Object.keys(some.body.items[0] as object).sort()).toEqual(
          Object.keys(all.body.items[0] as object).sort(),
        );
        expect(some.body.items.length).toBeLessThan(all.body.items.length);

        // Nothing private, and — the new one — `users.search_fold` itself
        // never reaches the wire. It is derived from two fields this response
        // already serves, so it discloses nothing, but a generated column that
        // leaked into a public list is how the next one would.
        for (const body of [all.body, some.body]) {
          const wire = JSON.stringify(body);
          for (const field of ['email', 'status', 'passwordHash', 'password_hash', 'searchFold', 'search_fold']) {
            expect(wire, `the user list must not contain ${field}`).not.toContain(`"${field}"`);
          }
        }

        // The search is not a privilege *among readers with standing*: a
        // second such account sees exactly what the first did.
        //
        // **D197 narrowed this claim, deliberately, and the narrowing is the
        // ruling.** D188 wrote that "a list that differed per caller would be a
        // new oracle rather than a closed one" — true of a list that varied per
        // SUBJECT, which would leak the relationship between reader and
        // subject. What varies now is one coarse, two-valued property of the
        // READER: whether they hold standing anywhere. A reader learns from it
        // only whether they themselves have standing, which they already know.
        // Two readers on the same side of that line still get byte-identical
        // answers, which is what this pins.
        const other = await teacher(app, db, 'nguoi-dung-thuong');
        const asUser = await other.get('/api/v1/users?limit=50&q=nguyen');
        expect(asUser.body.items).toEqual(some.body.items);

        // And the anonymous caller — the one F-51 measured taking the whole
        // roster in five requests — is refused, search or no search.
        const stranger = await request(app.getHttpServer()).get('/api/v1/users?limit=50&q=nguyen');
        expect(stranger.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('treats `%` and `_` as characters a person typed, not as wildcards', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedPupils(db);
        const gv = await teacher(app, db, 'kiemtrabon');
        // The oldest bug in every LIKE-backed search: `%` matching the whole
        // table. The fold runs first and the escape second, which is the order
        // that matters — `_` is folded to a space before it can be a wildcard,
        // and `%` survives the fold and is escaped.
        expect(await search(gv, '%')).toEqual([]);
        expect(await search(gv, '%nguyen')).toEqual([]);
        expect(await search(gv, '_')).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('GET /orgs/{slug}/members?q= — the roster a five-thousand-pupil school is read through (D185)', () => {
  async function seedSchool(
    app: Awaited<ReturnType<typeof buildApp>>,
    db: Db,
  ): Promise<ReturnType<typeof request.agent>> {
    const root = request.agent(app.getHttpServer());
    await registerAndLogin(root, 'lhp-root');
    await db
      .update(schema.users)
      .set({ globalRole: 'admin' })
      .where(eq(schema.users.username, 'lhp-root'));
    const created = await root
      .post('/api/v1/orgs')
      .send({ slug: SLUG, name: 'THPT Chuyên Lê Hồng Phong', visibility: 'public', joinPolicy: 'invite' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    await seedPupils(db);
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, SLUG));
    const rows = await db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users);
    await db.insert(orgMembers).values(
      rows
        .filter((r) => PUPILS.some((p) => p.username === r.username))
        .map((r) => ({ orgId: org!.id, userId: r.id, role: 'member' as const })),
    );
    return root;
  }

  it('finds a pupil by an unaccented name, and serves the name it matched', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const root = await seedSchool(app, db);
        const res = await root.get(`/api/v1/orgs/${SLUG}/members?q=nguyen`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        // `displayName` on the roster row is half the feature: without it the
        // answer to "find Nguyễn Văn An" is a page reading `hs000001`, and the
        // teacher is no better off than before they typed.
        expect(res.body.items).toEqual([
          expect.objectContaining({ username: 'gv-nguyen-van-an', displayName: 'Giáo viên chủ nhiệm' }),
          expect.objectContaining({ username: 'hs000001', displayName: 'Nguyễn Văn An' }),
          expect.objectContaining({ username: 'hs000002', displayName: 'Nguyễn Thị Bình' }),
        ]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('pages a search through its own cursor, carrying `q` on every page', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const root = await seedSchool(app, db);
        // Three matches and a page of two, so the walk must take the cursor
        // to see the third. `q` narrows the page and does not touch the order
        // or the seek, which is what makes this safe — the cursor is still a
        // username over a unique index.
        const first = await root.get(`/api/v1/orgs/${SLUG}/members?q=nguyen&limit=2`);
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body.items.map((m: { username: string }) => m.username)).toEqual([
          'gv-nguyen-van-an',
          'hs000001',
        ]);
        expect(first.body.nextCursor).toBe('hs000001');

        const second = await root.get(
          `/api/v1/orgs/${SLUG}/members?q=nguyen&limit=2&cursor=${encodeURIComponent(String(first.body.nextCursor))}`,
        );
        expect(second.status, JSON.stringify(second.body)).toBe(200);
        expect(second.body.items.map((m: { username: string }) => m.username)).toEqual(['hs000002']);
        expect(second.body.nextCursor).toBeNull();

        // And the page that FORGETS `q` is a different list entirely — the
        // web query key has to carry it, which is the mistake D180 caught in
        // the contest filter.
        const forgot = await root.get(
          `/api/v1/orgs/${SLUG}/members?limit=2&cursor=${encodeURIComponent(String(first.body.nextCursor))}`,
        );
        expect(forgot.body.items.map((m: { username: string }) => m.username)).toEqual([
          'hs000002',
          'hs000003',
        ]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('is still the roster: a school nobody may see answers 404, search or no search', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const root = await seedSchool(app, db);
        const hidden = await root
          .post('/api/v1/orgs')
          .send({ slug: 'truong-kin', name: 'Trường kín', visibility: 'private', joinPolicy: 'invite' });
        expect(hidden.status, JSON.stringify(hidden.body)).toBe(201);

        // A stranger. The search parameter must not become a second way in:
        // this route's gate is `findVisibleOrgRow`, exactly as it was, and
        // `q` is applied strictly inside it. That is why the roster search
        // lives here and NOT as an `org=` filter on the `@Public()`
        // `GET /users`, which has no organization gate at all.
        const stranger = request.agent(app.getHttpServer());
        await registerAndLogin(stranger, 'nguoi-la');
        const probe = await stranger.get('/api/v1/orgs/truong-kin/members?q=nguyen');
        expect(probe.status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

/**
 * Register, list and retire judge nodes:
 *
 *   corepack pnpm judge:node add <name>
 *   corepack pnpm judge:node list
 *   corepack pnpm judge:node rotate <name>
 *   corepack pnpm judge:node revoke <name>
 *
 * `judge_nodes` is what every judge credential is checked against — the
 * bridge handshake and the API's package-fetch guard both call
 * `verifyJudgeCredential` — and until now the only row anything created was
 * `judge-1`, hardcoded in `scripts/seed-problem.ts`. A second judge meant
 * the runbook's hand-written `insert ... encode(sha256(...))`, typed into
 * `psql`, with the token pasted in cleartext on the operator's command line
 * and into their shell history. That is the procedure this replaces
 * (docs/runbook.md, "Judging throughput"; D68).
 *
 * A CLI against `DATABASE_URL` rather than an endpoint, for the same reason
 * `bootstrap-admin.ts` is one: a route that mints judge credentials is a
 * permanent hole that only has to be reachable once.
 *
 * **`add` and `rotate` generate the token themselves and print it once.**
 * Neither takes a `--token`: a token pasted on argv lands in the shell
 * history of every machine it was ever typed on, and a judge credential is
 * the one this repository's own history has already leaked once
 * (`.env.example`'s shape, and every machine that ever ran this stack).
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  createDb,
  hashJudgeToken,
  isRevokedTokenHash,
  REVOKED_TOKEN_PREFIX,
  schema,
  type Db,
} from '@duckoj/db';

/**
 * The only driver `judged` implements. `judge_nodes.driver` exists so a
 * second one can be added without a migration; until there is one, a `--driver`
 * flag would be a knob whose every non-default value produces a judge nothing
 * will ever dispatch to.
 */
const DRIVER = 'dmoj';

/**
 * 32 bytes, hex — the same shape the runbook told operators to produce with
 * `openssl rand -hex 32`, so a token minted here is indistinguishable from
 * one minted the old way and `judge/judge.yml`'s template needs no change.
 */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * What `revoke` writes over `token_hash`.
 *
 * The row is NOT deleted, and this is the whole ruling (D68):
 * `grading_jobs.judge_node_id` references it `on delete set null`, so
 * deleting a retired judge would erase which machine graded every submission
 * it ever ran — the join this feature exists to create. Burning the hash
 * instead keeps the history and still refuses the credential.
 *
 * The marker is deliberately not valid hex: `verifyJudgeCredential` compares
 * `Buffer.from(hash, 'hex')` against the presented digest and returns false
 * on a length mismatch before `timingSafeEqual` ever runs, so a revoked node
 * fails closed no matter what token is presented. Prefixing the old hash
 * (rather than a constant) keeps `judge_nodes_token_idx` — a UNIQUE index on
 * `token_hash` — satisfiable when several nodes are revoked.
 */
export function revokedHash(previousHash: string): string {
  return `${REVOKED_TOKEN_PREFIX}${previousHash}`;
}

export function isRevoked(tokenHash: string): boolean {
  return isRevokedTokenHash(tokenHash);
}

export interface JudgeNodeRow {
  name: string;
  driver: string;
  revoked: boolean;
  lastSeen: Date | null;
  createdAt: Date;
  capabilities: unknown;
}

/**
 * Registers a new node and returns its token — generated here, stored only
 * as a sha256 hash, and therefore printable exactly once.
 *
 * Refuses an existing name rather than rotating its token: re-registering a
 * name is far more often a typo than an intentional rotation, and silently
 * invalidating a running judge's credential is a stack-wide outage that
 * looks like a network problem. Rotating a name deliberately is `rotate`,
 * which says out loud what it costs (D204). The refusal names it, because
 * D68 left this message pointing at `revoke` — and `revoke` then `add` under
 * the SAME name is refused too, which is the dead end F-58 found a province
 * standing in.
 */
export async function addJudgeNode(db: Db, name: string): Promise<{ name: string; token: string }> {
  const token = generateToken();
  const inserted = await db
    .insert(schema.judgeNodes)
    .values({ name, tokenHash: hashJudgeToken(token), driver: DRIVER })
    .onConflictDoNothing()
    .returning({ name: schema.judgeNodes.name });
  if (inserted.length === 0) {
    throw new Error(
      `judge node '${name}' already exists — 'judge:node rotate ${name}' mints it a new token, or pick another name`,
    );
  }
  return { name, token };
}

export async function listJudgeNodes(db: Db): Promise<JudgeNodeRow[]> {
  const rows = await db
    .select({
      name: schema.judgeNodes.name,
      driver: schema.judgeNodes.driver,
      tokenHash: schema.judgeNodes.tokenHash,
      lastSeen: schema.judgeNodes.lastSeen,
      createdAt: schema.judgeNodes.createdAt,
      capabilities: schema.judgeNodes.capabilities,
    })
    .from(schema.judgeNodes)
    .orderBy(schema.judgeNodes.name);
  return rows.map(({ tokenHash, ...rest }) => ({ ...rest, revoked: isRevoked(tokenHash) }));
}

/**
 * Mints a NEW token for a node that already exists, and refuses the old one
 * from the moment this returns (D204).
 *
 * This is the command `docs/guide/truoc-khi-trien-khai.md` §1 has always
 * needed and never had. Its step 1 told a province to `revoke judge-1` then
 * `add judge-1`; `add` refuses a name it already holds, revoked or not, so
 * the sequence burned the seeded credential and then failed, leaving a dead
 * judge and no way forward except SQL. The seeded credential is in this
 * repository's history and on every machine that has ever run this stack, so
 * that was not a missing convenience — it was a province unable to stop
 * anyone who read the repo from impersonating its judge.
 *
 * **The row is kept, exactly as `revoke` keeps it.** `grading_jobs.judge_node_id`
 * references it `on delete set null` (D68), so the machine that graded each
 * submission stays named across a rotation — which is the point of rotating
 * rather than retiring: it is the SAME judge, with a new key.
 *
 * **It works on a REVOKED node, and says so.** That is deliberate, and it is
 * the escape hatch: a province that already ran the struck instruction is
 * standing in the dead end right now, and `rotate` is the only way out that
 * does not involve hand-typed SQL. Un-burning a credential somebody
 * deliberately refused is loud rather than silent — the CLI prints a line
 * saying the node was revoked and is being re-admitted.
 *
 * **What it does to a CONNECTED judge**: it disconnects it, within one
 * revalidation poll (five seconds, D81). `judged` remembers the digest of
 * the key each connection handshook with and re-checks the pair, so a
 * connection holding the old token is no longer admitted and goes through
 * `retire` — the same path as a judge that died. Whatever it was grading is
 * abandoned rather than failed: `DmojDriver.onJudgeGone` emits no
 * `GradingEvent`, releases the lease immediately, and the job returns to
 * `queued` to be graded again by whichever judge comes back. The queue then
 * parks rather than failing (D68: an empty fleet waits), so the cost of a
 * rotation is latency, not verdicts.
 *
 * The judge cannot come back on its own: it reads `JUDGE_TOKEN` from its
 * container environment (`judge/entrypoint.sh` renders `judge/judge.yml` at
 * start), so until the operator puts the new token in `.env` and RECREATES
 * the container, this judge redials and is refused. `docs/runbook.md`,
 * "Rotating a judge's token", carries the ordered sequence.
 */
export async function rotateJudgeNode(
  db: Db,
  name: string,
): Promise<{ name: string; token: string; wasRevoked: boolean }> {
  const rows = await db
    .select({ tokenHash: schema.judgeNodes.tokenHash })
    .from(schema.judgeNodes)
    .where(eq(schema.judgeNodes.name, name))
    .limit(1);
  const row = rows[0];
  // Never falls back to registering it. A typo on a rotation must not mint a
  // credential for a machine that does not exist — `add` is the command that
  // creates, and it is one word away.
  if (!row) throw new Error(`no judge node named '${name}' — 'add' registers a new one`);
  const token = generateToken();
  await db
    .update(schema.judgeNodes)
    .set({ tokenHash: hashJudgeToken(token) })
    .where(eq(schema.judgeNodes.name, name));
  // `last_seen` and `capabilities` are deliberately left alone. The judge
  // rewrites `capabilities` on its next handshake (D68 — executors are
  // handshake-only), and `last_seen` moving forward again is exactly how an
  // operator confirms the rotation landed.
  return { name, token, wasRevoked: isRevoked(row.tokenHash) };
}

/**
 * Burns a node's token. Idempotent: revoking an already-revoked node
 * reports `alreadyRevoked` rather than double-prefixing its hash, which
 * would still fail closed but would make the marker unreadable.
 */
export async function revokeJudgeNode(
  db: Db,
  name: string,
): Promise<{ alreadyRevoked: boolean }> {
  const rows = await db
    .select({ tokenHash: schema.judgeNodes.tokenHash })
    .from(schema.judgeNodes)
    .where(eq(schema.judgeNodes.name, name))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`no judge node named '${name}'`);
  if (isRevoked(row.tokenHash)) return { alreadyRevoked: true };
  await db
    .update(schema.judgeNodes)
    .set({ tokenHash: revokedHash(row.tokenHash) })
    .where(eq(schema.judgeNodes.name, name));
  return { alreadyRevoked: false };
}

const USAGE = `usage:
  judge:node add <name>       register a node and print its token (once)
  judge:node list             every registered node, and whether it is revoked
  judge:node rotate <name>    mint a new token for a node that exists (once)
  judge:node revoke <name>    refuse the node's token, keeping its grading history`;

// Same direct-invocation check as `bootstrap-admin.ts`.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const [command, name] = process.argv.slice(2);
  if (command !== 'add' && command !== 'list' && command !== 'rotate' && command !== 'revoke') {
    console.error(USAGE);
    process.exit(1);
  }
  if (command !== 'list' && (name === undefined || name === '')) {
    console.error(`${command} needs a node name\n\n${USAGE}`);
    process.exit(1);
  }

  const { db, close } = createDb(url);
  try {
    if (command === 'add') {
      const result = await addJudgeNode(db, name!);
      console.log(`registered judge node '${result.name}' (driver ${DRIVER})`);
      console.log(`token: ${result.token}`);
      console.log('This is printed once — nothing can recover it. Put it in .env and in the');
      console.log("judge container's JUDGE_TOKEN, then bring that judge up.");
    } else if (command === 'rotate') {
      const result = await rotateJudgeNode(db, name!);
      if (result.wasRevoked) {
        console.log(`judge node '${result.name}' was revoked — this rotation RE-ADMITS it.`);
      }
      console.log(`rotated judge node '${result.name}'; its previous token is refused from now on`);
      console.log(`token: ${result.token}`);
      console.log('This is printed once — nothing can recover it.');
      console.log('');
      console.log(`The judge answering to '${result.name}' is now disconnected within five`);
      console.log('seconds and cannot reconnect until it holds this token: put it in .env as');
      console.log('JUDGE_TOKEN and RECREATE the container (podman-compose up -d judge) — a');
      console.log('restart re-uses the old environment. Submissions queue meanwhile; anything');
      console.log('mid-grade is requeued, not failed. docs/runbook.md, "Rotating a judge\'s');
      console.log('token", has the ordered sequence.');
    } else if (command === 'list') {
      const rows = await listJudgeNodes(db);
      if (rows.length === 0) console.log('no judge nodes registered');
      for (const row of rows) {
        console.log(
          JSON.stringify({
            name: row.name,
            driver: row.driver,
            revoked: row.revoked,
            lastSeen: row.lastSeen?.toISOString() ?? null,
            capabilities: row.capabilities,
          }),
        );
      }
    } else {
      const result = await revokeJudgeNode(db, name!);
      console.log(
        result.alreadyRevoked
          ? `judge node '${name!}' was already revoked — nothing to do`
          : `revoked judge node '${name!}'; its row and grading history are kept`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await close();
    process.exit(1);
  }
  await close();
}

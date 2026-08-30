/**
 * Register, list and retire judge nodes:
 *
 *   corepack pnpm judge:node add <name>
 *   corepack pnpm judge:node list
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
 * **`add` generates the token itself and prints it once.** It takes no
 * `--token`: an operator-chosen judge token is the one credential nobody
 * ever rotates, and accepting one on argv would put it in the shell history
 * of every machine it was ever registered from.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, hashJudgeToken, schema, type Db } from '@duckoj/db';

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
  return `revoked:${previousHash}`;
}

export function isRevoked(tokenHash: string): boolean {
  return tokenHash.startsWith('revoked:');
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
 * looks like a network problem. Rotation is `revoke` then `add` under a new
 * name, which also leaves the old name's grading history addressable.
 */
export async function addJudgeNode(db: Db, name: string): Promise<{ name: string; token: string }> {
  const token = generateToken();
  const inserted = await db
    .insert(schema.judgeNodes)
    .values({ name, tokenHash: hashJudgeToken(token), driver: DRIVER })
    .onConflictDoNothing()
    .returning({ name: schema.judgeNodes.name });
  if (inserted.length === 0) {
    throw new Error(`judge node '${name}' already exists — revoke it, or pick another name`);
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
  if (command !== 'add' && command !== 'list' && command !== 'revoke') {
    console.error(USAGE);
    process.exit(1);
  }
  if ((command === 'add' || command === 'revoke') && (name === undefined || name === '')) {
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

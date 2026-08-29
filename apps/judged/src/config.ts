import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(9999),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WORKER_ID: z.string().min(1).default('judged-1'),
  /**
   * How many independent claim loops this process runs (see
   * `startWorkerPool`). Default 1: **one loop per judge container**, and this
   * stack runs one judge.
   *
   * A DMOJ judge grades one submission per connection, and each loop now
   * reserves a judge slot before it claims (`JudgeDriver.tryAcquireSlot`), so
   * a second loop against a single judge never wins a slot — it polls and
   * backs off. Raising this past the number of judges is therefore inert, not
   * merely unhelpful; raise it with the fleet, in step (D29, docs/runbook.md
   * "Judging throughput"). Capped at 16 for the same reason.
   */
  JUDGED_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  /** Where judge-agent's `POST /packages/ensure` lives, dialled before every dispatch. */
  AGENT_ORIGIN: z.string().url().default('http://judge-agent:3002'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface JudgedConfig {
  databaseUrl: string;
  redisUrl: string;
  bridgePort: number;
  healthPort: number;
  workerId: string;
  concurrency: number;
  agentOrigin: string;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): JudgedConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${detail}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    bridgePort: e.BRIDGE_PORT,
    healthPort: e.HEALTH_PORT,
    workerId: e.WORKER_ID,
    concurrency: e.JUDGED_CONCURRENCY,
    agentOrigin: e.AGENT_ORIGIN,
    logLevel: e.LOG_LEVEL,
  };
}

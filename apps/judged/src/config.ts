import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(9999),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WORKER_ID: z.string().min(1).default('judged-1'),
  /**
   * How many independent claim loops this process runs (see
   * `startWorkerPool`). Default 2: one loop means a single slow grade blocks
   * every submission behind it, which on a contest day is the difference
   * between a queue that drains and one that does not. Capped at 16 because
   * the DMOJ judge, not `judged`, is the real ceiling — anything past the
   * number of judge containers only deepens the queue at the judge.
   */
  JUDGED_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
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

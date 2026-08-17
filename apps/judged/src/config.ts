import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(9999),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WORKER_ID: z.string().min(1).default('judged-1'),
  /**
   * Phase 1 serves exactly one seeded problem, so the hash → code mapping is a
   * constant. Phase 2 replaces this with judge-agent's fetch-by-hash.
   */
  PROBLEM_CODE: z.string().min(1).default('aplusb'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface JudgedConfig {
  databaseUrl: string;
  redisUrl: string;
  bridgePort: number;
  healthPort: number;
  workerId: string;
  problemCode: string;
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
    problemCode: e.PROBLEM_CODE,
    logLevel: e.LOG_LEVEL,
  };
}

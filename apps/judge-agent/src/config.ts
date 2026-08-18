import { z } from 'zod';

const EnvSchema = z.object({
  /** Where the API lives — `GET /internal/packages/{hash}/archive` is fetched from here. */
  API_ORIGIN: z.string().url(),
  /** This judge's identity in `judge_nodes`. Paired with `JUDGE_TOKEN` in the `Judge <name>:<token>` header. */
  JUDGE_NAME: z.string().min(1),
  /**
   * This judge's credential. Never logged and never placed in a URL — it
   * travels only in the `Authorization` header of the archive fetch.
   */
  JUDGE_TOKEN: z.string().min(1),
  /** judge-server's problem directory. Packages are materialised as `<PROBLEMS_DIR>/<hash>`. */
  PROBLEMS_DIR: z.string().min(1).default('/problems'),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
});

export interface JudgeAgentConfig {
  apiOrigin: string;
  judgeName: string;
  judgeToken: string;
  problemsDir: string;
  agentPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): JudgeAgentConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${detail}`);
  }
  const e = parsed.data;
  return {
    apiOrigin: e.API_ORIGIN,
    judgeName: e.JUDGE_NAME,
    judgeToken: e.JUDGE_TOKEN,
    problemsDir: e.PROBLEMS_DIR,
    agentPort: e.AGENT_PORT,
  };
}

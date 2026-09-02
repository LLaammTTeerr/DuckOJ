import { z } from 'zod';

/**
 * The three rungs of D197's ladder, most protective first in argument and
 * last in this union so the enum below reads in the order an operator loosens
 * it. Declared here rather than in `authz/` because the config schema is what
 * parses it, and a type that lived beside its consumer would make the parser
 * import from the module it configures.
 */
export type NameDisclosure = 'public' | 'authenticated' | 'affiliated';

/**
 * Treats the empty string as "not set".
 *
 * This is what makes the mail variables safe to wire through
 * `docker-compose.yml`, and it is not a nicety. Compose has no way to pass a
 * variable *only if the operator set one*: the file's own convention —
 * `WS_EXTRA_ORIGINS: ${WS_EXTRA_ORIGINS:-}` — renders an unset variable as
 * the EMPTY STRING, and the container is handed `SMTP_HOST=`. Read literally
 * that is a zero-length host failing `.min(1)`, a `SMTP_PORT=''` that coerces
 * to `0` and fails `.min(1)`, and a `SMTP_SECURE=''` outside the enum: three
 * refusals, one boot crash, on a stack whose `.env` simply says nothing about
 * mail. Before F-40 nothing noticed, because no `SMTP_*` variable reached the
 * `api` service at all.
 *
 * So the rule is stated once, here, rather than being worked around with a
 * defaulting incantation per variable in a YAML file: an environment variable
 * that is present and empty means exactly what an absent one means. It wraps
 * the mail variables and `NAME_DISCLOSURE` — every OPTIONAL variable compose
 * passes through unconditionally, and nothing else. Extending it to a
 * required variable would turn "you forgot DATABASE_URL" into a confusing
 * default rather than the refusal it should be.
 *
 * `NAME_DISCLOSURE` is here for exactly the reason the mail block is (F-40):
 * compose renders an unset variable as the empty string, and a bare
 * `z.enum([...]).default('affiliated')` reads `''` as a value outside the
 * enum and refuses to boot a stack whose `.env` simply says nothing about
 * name disclosure. A policy whose safe default cannot survive being left
 * unset is not a safe default.
 */
function unsetWhenBlank<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SESSION_COOKIE_NAME: z.string().default('duckoj_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(720),
  TOTP_ENC_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'must be 32 bytes of lowercase hex'),
  PUBLIC_ORIGIN: z.string().url(),
  // Extra browser origins allowed to open the /ws socket besides PUBLIC_ORIGIN
  // (comma-separated) — the e2e host `http://localhost:8080` on a box that
  // publishes under a tailnet name. CORS is unaffected: same-origin HTTP
  // needs none, and the WebSocket Origin check (D70) is the only consumer.
  WS_EXTRA_ORIGINS: z.string().default(''),
  /**
   * A pino level. `silent` is one of pino's own and was the one level this
   * enum did not admit — so `LOG_LEVEL=silent` in a `.env` crashed the API at
   * boot with "Invalid environment configuration", and the test harness's
   * hand-written config (which sets exactly that, to keep ~900 specs quiet)
   * was a config `loadConfig` would have refused. Admitted here so the
   * harness can go through this parser at all (D91), and so an operator who
   * wants a silent container gets one instead of a boot loop.
   */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PACKAGE_STORE_DIR: z.string().min(1).default('/var/lib/duckoj/packages'),
  // 256 MiB. Injectable per-environment (and per-test) rather than a
  // hardcoded controller constant, so a test can set it to a few bytes and
  // actually exercise the over-limit path without uploading 256 MiB.
  PACKAGE_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(268_435_456),

  TYPST_BIN: z.string().min(1).optional(),

  /**
   * How much of a person this deployment publishes (D197).
   *
   * A `username` is an identifier a pupil chose or was issued; a
   * `display_name` on a provincial host is very often a twelve-year-old's
   * real, full name. This is the one switch that separates them, and every
   * surface that renders a person consults the single predicate in
   * `apps/api/src/authz/name-disclosure.ts` — never its own copy of the rule.
   *
   *   `affiliated`    (default) real names to a reader with standing: a
   *                   global admin or setter, a holder of any organization
   *                   role, a caller a surface has already authorized over
   *                   exactly these people (contest staff on an export), and
   *                   always to the account itself. Everyone else — an
   *                   anonymous stranger, and an account that registered
   *                   thirty seconds ago — is shown the USERNAME in the
   *                   `displayName` field.
   *   `authenticated` real names to any signed-in caller. The middle rung,
   *                   for a deployment that wants a parent with an account to
   *                   find their child by name.
   *   `public`        real names to anyone. The behaviour before D197, and
   *                   the right setting for an open public judge whose
   *                   competitors are adults.
   *
   * The default is the PROTECTIVE one on purpose: an operator who reads
   * nothing and sets nothing gets a host that does not hand a stranger 264
   * children's names (B-35's measured figure). The open behaviour is the one
   * you opt into.
   */
  NAME_DISCLOSURE: unsetWhenBlank(
    z.enum(['public', 'authenticated', 'affiliated']).default('affiliated'),
  ),

  /**
   * SMTP. Absent means mail is logged rather than sent (3f §2) — a developer
   * must not need a mail server to register a user, and neither must a test.
   * Resend is configured here like any other host (`smtp.resend.com`), which
   * is why no provider SDK exists in this codebase.
   *
   * Every one of the six is wrapped in `unsetWhenBlank`, because since F-40
   * `docker-compose.yml` passes all six into the `api` service and passes
   * them EMPTY on a deployment that configured no mail. See that helper for
   * what reading them literally would do at boot.
   */
  SMTP_HOST: unsetWhenBlank(z.string().min(1).optional()),
  SMTP_PORT: unsetWhenBlank(z.coerce.number().int().min(1).max(65535).default(587)),
  // An empty username is not a username. Left as `''` it would build a
  // nodemailer `auth` block and make the transport send `AUTH LOGIN` with no
  // credential — a server that accepts anonymous relay would take it, and one
  // that does not would refuse a connection the operator believes is
  // unauthenticated.
  SMTP_USER: unsetWhenBlank(z.string().optional()),
  SMTP_PASSWORD: unsetWhenBlank(z.string().optional()),
  SMTP_SECURE: unsetWhenBlank(
    z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  ),
  // The default lives HERE and nowhere else. Repeating it inside a compose
  // `${MAIL_FROM:-DuckOJ <no-reply@duckoj.local>}` would put a string with
  // spaces and angle brackets through podman-compose's interpolation for no
  // gain, and give the deployment a second place to disagree with the code.
  MAIL_FROM: unsetWhenBlank(z.string().default('DuckOJ <no-reply@duckoj.local>')),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  redisUrl: string;
  sessionCookieName: string;
  sessionTtlHours: number;
  totpEncKey: Buffer;
  publicOrigin: string;
  /**
   * `PUBLIC_ORIGIN` plus `WS_EXTRA_ORIGINS` — the browser-origin allow-list.
   *
   * Two readers now: the WebSocket upgrade (D70) and `CsrfOriginGuard`, which
   * checks the same list on every cookie-authenticated state change (D82).
   * ONE list, deliberately not split in two: a deploy that may open a socket
   * from an origin and may not write from it — or the reverse — is a
   * configuration nobody wants and everybody would eventually produce by
   * editing one variable and not the other. The name is kept as it is; a
   * rename would touch `.env` on the live host to say nothing new.
   */
  wsAllowedOrigins: readonly string[];
  logLevel: string;
  packageStoreDir: string;
  packageUploadMaxBytes: number;
  /** `null` when no SMTP host is configured — mail is logged instead. */
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
  } | null;
  mailFrom: string;
  /**
   * Path to a `typst` binary; `null` disables statement PDFs (the route
   * answers 501). Explicit — never guessed from PATH — so a deploy states
   * whether it renders PDFs the same way it states whether it sends mail.
   */
  typstBin: string | null;
  /**
   * D197's one switch, read in one place. Its only consumer is
   * `apps/api/src/authz/name-disclosure.ts`; nothing else in the API is
   * allowed to branch on it, which is what
   * `apps/api/test/name-disclosure-guard.spec.ts` enforces (D198).
   */
  nameDisclosure: NameDisclosure;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${detail}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    sessionCookieName: e.SESSION_COOKIE_NAME,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    totpEncKey: Buffer.from(e.TOTP_ENC_KEY, 'hex'),
    publicOrigin: e.PUBLIC_ORIGIN,
    wsAllowedOrigins: [
      e.PUBLIC_ORIGIN,
      ...e.WS_EXTRA_ORIGINS.split(',').map((o) => o.trim()).filter((o) => o.length > 0),
    ],
    logLevel: e.LOG_LEVEL,
    packageStoreDir: e.PACKAGE_STORE_DIR,
    packageUploadMaxBytes: e.PACKAGE_UPLOAD_MAX_BYTES,
    smtp:
      e.SMTP_HOST === undefined
        ? null
        : {
            host: e.SMTP_HOST,
            port: e.SMTP_PORT,
            secure: e.SMTP_SECURE,
            ...(e.SMTP_USER === undefined ? {} : { user: e.SMTP_USER }),
            ...(e.SMTP_PASSWORD === undefined ? {} : { password: e.SMTP_PASSWORD }),
          },
    mailFrom: e.MAIL_FROM,
    typstBin: e.TYPST_BIN ?? null,
    nameDisclosure: e.NAME_DISCLOSURE,
  };
}

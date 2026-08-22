import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  SESSION_COOKIE_NAME: z.string().default('duckoj_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(720),
  TOTP_ENC_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'must be 32 bytes of lowercase hex'),
  PUBLIC_ORIGIN: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PACKAGE_STORE_DIR: z.string().min(1).default('/var/lib/duckoj/packages'),
  // 256 MiB. Injectable per-environment (and per-test) rather than a
  // hardcoded controller constant, so a test can set it to a few bytes and
  // actually exercise the over-limit path without uploading 256 MiB.
  PACKAGE_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(268_435_456),

  /**
   * SMTP. Absent means mail is logged rather than sent (3f §2) — a developer
   * must not need a mail server to register a user, and neither must a test.
   * Resend is configured here like any other host (`smtp.resend.com`), which
   * is why no provider SDK exists in this codebase.
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MAIL_FROM: z.string().default('DuckOJ <no-reply@duckoj.local>'),
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
  };
}

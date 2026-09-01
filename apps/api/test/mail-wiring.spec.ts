/**
 * F-40 — the variables that configure mail must actually reach the process.
 *
 * `apps/api/src/config/config.schema.ts` has read a full `SMTP_*` set since
 * 3f, `apps/api/src/mail` has had two transports and a localised template pair
 * since D57, and every one of it was unreachable on a deployed stack: the
 * `api` service in `docker-compose.yml` passed **no** `SMTP_*` variable at
 * all, and `.env.example` named none of them. An operator could fill in every
 * line they could think of, restart, and get the same silent `LogMailer` they
 * had before.
 *
 * That is not a bug a unit test against a fake mailer can see, because the
 * fake is exactly what the deployment was stuck with. It is visible in the
 * ONE place the wiring lives — the compose file — so this is a source-reading
 * test, for `compose-project-name.spec.ts`'s and `dockerfile-manifest.spec.ts`'s
 * reason: the property that matters ("does the container get the variable")
 * is right there in the file, and reproducing it any other way needs a whole
 * stack.
 *
 * **Nothing here is a hardcoded variable list.** The names are DERIVED from
 * the schema's own source, so a seventh mail variable added to the schema
 * tomorrow fails this test until compose and `.env.example` learn it too.
 * A hardcoded list would just be the same failure mode one level up.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.schema.js';
import { LogMailer, SmtpMailer } from '../src/mail/mailer.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const composeSource = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8');
const schemaSource = readFileSync(
  join(repoRoot, 'apps', 'api', 'src', 'config', 'config.schema.ts'),
  'utf8',
);

/**
 * The mail variables `EnvSchema` actually reads, taken from its source.
 *
 * `SMTP_*` plus `MAIL_FROM`: the two prefixes are the whole mail surface of
 * the schema, and a key is only counted where it appears as an object key
 * (`NAME:`), which is what the schema object is made of. Read from the file
 * rather than imported because a Zod schema does not expose its key list in a
 * form that survives `.optional()`/`.transform()` wrappers without reaching
 * into internals that change between minor versions.
 */
function mailVariablesTheSchemaReads(): string[] {
  const names = [...schemaSource.matchAll(/^\s*(SMTP_[A-Z_]+|MAIL_FROM):/gm)].map((m) => m[1]!);
  return [...new Set(names)].sort();
}

/**
 * The `environment:` keys of one compose service.
 *
 * Indentation is the parse: a service is a two-space key under `services:`,
 * its blocks are four-space keys, and its environment entries are six-space
 * keys. Hand-rolled rather than through a YAML library because this repo has
 * none as a dependency and adding one to read six lines would be the larger
 * change.
 */
function environmentOf(service: string): Record<string, string> {
  const lines = composeSource.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) throw new Error(`no service '${service}' in docker-compose.yml`);
  const env: Record<string, string> = {};
  let inEnvironment = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) break; // the next service
    if (/^ {4}\S/.test(line)) inEnvironment = /^ {4}environment:/.test(line);
    if (!inEnvironment) continue;
    const entry = /^ {6}([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/.exec(line);
    if (entry) env[entry[1]!] = entry[2]!;
  }
  return env;
}

/** A minimal environment the schema accepts, with nothing about mail in it. */
const BASE_ENV = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  TOTP_ENC_KEY: 'a'.repeat(64),
  PUBLIC_ORIGIN: 'http://localhost',
};

describe('the SMTP configuration reaches the api container', () => {
  it('names the variables the schema reads, so the assertions below cannot iterate over nothing', () => {
    expect(mailVariablesTheSchemaReads()).toEqual([
      'MAIL_FROM',
      'SMTP_HOST',
      'SMTP_PASSWORD',
      'SMTP_PORT',
      'SMTP_SECURE',
      'SMTP_USER',
    ]);
  });

  it('passes every one of them into the `api` service', () => {
    const apiEnv = environmentOf('api');
    for (const name of mailVariablesTheSchemaReads()) {
      expect(apiEnv, `docker-compose.yml: api does not receive ${name}`).toHaveProperty(name);
    }
  });

  it('carries values by reference, never a literal credential', () => {
    // `docker-compose.yml` is committed. Every mail variable must be an
    // interpolation of the operator's `.env` — a literal here is a secret in
    // git, and the one that would matter most is the password.
    const apiEnv = environmentOf('api');
    for (const name of mailVariablesTheSchemaReads()) {
      expect(apiEnv[name], `${name} must be a \${...} reference, not a literal`).toMatch(
        /^\$\{[A-Z_]+(:-[^}]*)?\}$/,
      );
    }
  });

  it('does not widen any other service — nothing else sends mail', () => {
    for (const service of ['judged', 'judge', 'migrate']) {
      const env = environmentOf(service);
      for (const name of mailVariablesTheSchemaReads()) {
        expect(env, `${service} has no business with ${name}`).not.toHaveProperty(name);
      }
    }
  });

  it('documents every one of them in .env.example', () => {
    // The operator's copy of the list. `.env.example` disagreeing with the
    // code is what F-40 found: it named not one of the six.
    for (const name of mailVariablesTheSchemaReads()) {
      expect(envExample, `.env.example does not mention ${name}`).toMatch(
        new RegExp(`^#?${name}=`, 'm'),
      );
    }
  });
});

describe('an unset SMTP variable and an empty one mean the same thing', () => {
  /**
   * This is what makes the compose wiring safe.
   *
   * Compose has no way to pass a variable "only if it is set": the file's own
   * convention (`WS_EXTRA_ORIGINS: ${WS_EXTRA_ORIGINS:-}`) renders an unset
   * variable as the EMPTY STRING, and the container gets `SMTP_HOST=`. Read
   * literally by the schema that would be a one-character host that fails
   * `.min(1)`, a `SMTP_PORT=''` that coerces to `0` and fails `.min(1)`, and
   * a `SMTP_SECURE=''` outside the enum — three refusals, so the API would
   * crash-loop at boot the moment this slot wired the variables through. The
   * fix belongs in the schema, not in a compose incantation.
   */
  const emptyEverywhere = {
    ...BASE_ENV,
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_SECURE: '',
    MAIL_FROM: '',
  };

  it('boots with every mail variable rendered empty, exactly as compose renders them', () => {
    expect(() => loadConfig(emptyEverywhere)).not.toThrow();
  });

  it('reads an empty SMTP_HOST as "no mail configured", not as a host', () => {
    expect(loadConfig(emptyEverywhere).smtp).toBeNull();
  });

  it('falls back to the schema default for an empty MAIL_FROM', () => {
    // The default lives in ONE place — the schema — so compose does not have
    // to repeat `DuckOJ <no-reply@duckoj.local>` inside a `${...:-}`.
    expect(loadConfig(emptyEverywhere).mailFrom).toBe(loadConfig(BASE_ENV).mailFrom);
  });

  it('applies the port and TLS defaults when only the host is given', () => {
    const config = loadConfig({ ...emptyEverywhere, SMTP_HOST: 'smtp.resend.com' });
    expect(config.smtp).toEqual({ host: 'smtp.resend.com', port: 587, secure: false });
  });

  it('does not invent an empty username, which would send AUTH with no credential', () => {
    const config = loadConfig({
      ...emptyEverywhere,
      SMTP_HOST: 'smtp.resend.com',
      SMTP_USER: '',
      SMTP_PASSWORD: '',
    });
    expect(config.smtp?.user).toBeUndefined();
    expect(config.smtp?.password).toBeUndefined();
  });

  it('still carries a real username and password through', () => {
    const config = loadConfig({
      ...emptyEverywhere,
      SMTP_HOST: 'smtp.resend.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'resend',
      SMTP_PASSWORD: 're_placeholder',
    });
    expect(config.smtp).toEqual({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      user: 'resend',
      password: 're_placeholder',
    });
  });
});

describe('the transport follows the configuration', () => {
  it('is the no-op when nothing is configured, and SMTP when something is', () => {
    // The factory `MailModule` runs, restated: a transport chosen by hand
    // here would prove nothing about the one the container gets.
    const withoutSmtp = loadConfig(BASE_ENV);
    const withSmtp = loadConfig({ ...BASE_ENV, SMTP_HOST: 'smtp.example' });
    expect(withoutSmtp.smtp ? 'smtp' : 'log').toBe('log');
    expect(withSmtp.smtp ? 'smtp' : 'log').toBe('smtp');
    expect(new LogMailer().kind).toBe('log');
    expect(new SmtpMailer(withSmtp).kind).toBe('smtp');
  });
});

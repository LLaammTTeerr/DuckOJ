/**
 * F-40 — proof that a configured DuckOJ actually speaks SMTP.
 *
 * Every other mail test in this suite asserts against `LogMailer.sent`, which
 * is the transport a deployment gets when the wiring is BROKEN. Those tests
 * were all green while no `SMTP_*` variable reached the `api` container at
 * all: a fake mailer cannot fail the way a missing environment variable does.
 *
 * So this file holds a real SMTP conversation. Not a mocked `Transporter`,
 * not a stubbed `sendMail` — a TCP listener speaking enough ESMTP for
 * nodemailer to complete a transaction, with the message read back off the
 * wire and the ENVELOPE (`RCPT TO`) checked separately from the headers.
 *
 * **A listener, not a container**, for two reasons the brief allows: this
 * host is thermally capped and a mail-server image is a pull and a boot for
 * a protocol we need six verbs of; and a hand-written server is the only
 * kind that can assert on the envelope, which is what actually decides where
 * a mail goes.
 *
 * No third party is dialled and nothing leaves this machine — the listener
 * binds `127.0.0.1` on an ephemeral port.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config/config.schema.js';
import { LogMailer, SmtpMailer, type Mailer } from '../src/mail/mailer.js';
import { DashboardService, type RedisHealth } from '../src/authz/dashboard.access.js';
import { AppError } from '../src/common/app.error.js';
import type { Actor } from '../src/authz/actor.js';
import type { Db } from '@duckoj/db';
import { emailVerificationMail, passwordResetMail } from '../src/mail/templates.js';

/** One completed SMTP transaction, as the server saw it. */
interface Delivered {
  /** `MAIL FROM:<...>` — the envelope sender, which is not the `From:` header. */
  mailFrom: string;
  /** `RCPT TO:<...>` — where the mail actually goes. */
  recipients: string[];
  /** Everything between `DATA` and the terminating dot. */
  raw: string;
}

/**
 * A deliberately small ESMTP server.
 *
 * It advertises `8BITMIME` and **nothing else** — in particular no `STARTTLS`
 * and no `AUTH`. nodemailer upgrades or authenticates only when the server
 * says it can, so an empty capability list keeps the conversation to the six
 * verbs below instead of pulling a TLS handshake into a unit test.
 */
class FakeSmtpServer {
  private readonly server: Server;
  readonly delivered: Delivered[] = [];
  port = 0;

  constructor() {
    this.server = createServer((socket) => {
      this.serve(socket);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    this.port = address.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private serve(socket: Socket): void {
    let inData = false;
    let body = '';
    let current: Delivered = { mailFrom: '', recipients: [], raw: '' };
    let buffer = '';
    socket.setEncoding('utf8');
    socket.write('220 duckoj-test ESMTP\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // Line-oriented, and the buffer is kept across chunks: a `DATA` payload
      // arrives in whatever pieces the kernel felt like, and splitting each
      // chunk on its own would tear a header in half.
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            current.raw = body;
            this.delivered.push(current);
            current = { mailFrom: '', recipients: [], raw: '' };
            body = '';
            socket.write('250 2.0.0 Ok: queued\r\n');
            continue;
          }
          // Dot-stuffing, undone: RFC 5321 §4.5.2 doubles a leading dot.
          body += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-duckoj-test\r\n250 8BITMIME\r\n');
        } else if (upper.startsWith('HELO')) {
          socket.write('250 duckoj-test\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          current.mailFrom = addressIn(line);
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          current.recipients.push(addressIn(line));
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  }
}

/** The address out of `MAIL FROM:<a@b>` / `RCPT TO:<a@b> PARAM=...`. */
function addressIn(line: string): string {
  return /<([^>]*)>/.exec(line)?.[1] ?? '';
}

/** Headers (folded lines joined) and body, split at the blank line. */
function parseMessage(raw: string): { headers: Record<string, string>; body: string } {
  const separator = raw.indexOf('\n\n');
  const headerBlock = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? '' : raw.slice(separator + 2);
  const headers: Record<string, string> = {};
  let name = '';
  for (const line of headerBlock.split('\n')) {
    if (/^[ \t]/.test(line) && name !== '') {
      // A folded header is one logical line whose fold stands for a single
      // space (RFC 5322 §2.2.3). The space is put back rather than dropped —
      // `decodeHeader` is what knows that whitespace BETWEEN two encoded
      // words is not part of the text.
      headers[name] += ` ${line.trim()}`;
      continue;
    }
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    name = match[1]!.toLowerCase();
    headers[name] = match[2]!;
  }
  return { headers, body };
}

/**
 * RFC 2047 encoded words, decoded.
 *
 * Load-bearing for this file's whole point: every Vietnamese subject leaves
 * nodemailer as `=?UTF-8?B?…?=`, so asserting on the raw header would fail
 * for an encoding reason and say nothing about whether the right mail was
 * sent.
 */
function decodeHeader(value: string): string {
  // Adjacent encoded words are separated by whitespace that is NOT displayed
  // (RFC 2047 §6.2) — and nodemailer emits exactly that, because it splits a
  // long subject at a byte boundary that can land mid-word. Left in, the
  // Vietnamese subject decodes to "của b ạn" and the assertion fails for a
  // reason that has nothing to do with which mail was sent.
  return value.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset, kind, text) => {
    const encoding = String(charset).toLowerCase() === 'utf-8' ? 'utf8' : 'latin1';
    if (String(kind).toUpperCase() === 'B') {
      return Buffer.from(String(text), 'base64').toString(encoding);
    }
    return decodeQuotedPrintable(String(text).replaceAll('_', ' '), encoding);
  });
}

function decodeQuotedPrintable(text: string, encoding: BufferEncoding): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (text[i] === '=' && text[i + 1] === '\n') {
      i += 1; // a soft line break
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString(encoding);
}

/** The body, whatever `Content-Transfer-Encoding` nodemailer chose. */
function decodeBody(headers: Record<string, string>, body: string): string {
  const encoding = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase().trim();
  if (encoding === 'base64') return Buffer.from(body, 'base64').toString('utf8');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body, 'utf8');
  return body;
}

const server = new FakeSmtpServer();

beforeAll(async () => {
  await server.start();
});
afterAll(async () => {
  await server.stop();
});

/** A config built the way a container's would be — through the real parser. */
function configPointingAtTheListener(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'production',
    PORT: '3000',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    TOTP_ENC_KEY: 'a'.repeat(64),
    PUBLIC_ORIGIN: 'https://oj.example',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(server.port),
    // Exactly what compose renders for an operator who set only a host.
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_SECURE: 'false',
    MAIL_FROM: 'DuckOJ <no-reply@duckoj.example>',
    ...overrides,
  });
}

describe('a configured DuckOJ delivers a real message over SMTP', () => {
  it('sends the Vietnamese password-reset mail to the address that asked for it', async () => {
    const before = server.delivered.length;
    const mailer = new SmtpMailer(configPointingAtTheListener());
    await mailer.send({
      to: 'hocsinh@truong.example',
      ...passwordResetMail('vi', { url: 'https://oj.example/reset-password?token=abc', ttlMinutes: 60 }),
    });

    const delivered = server.delivered.at(-1);
    expect(server.delivered.length - before).toBe(1);
    expect(delivered).toBeDefined();
    // The envelope decides where the mail goes; the header only decides what
    // the reader sees. Asserted separately, on purpose.
    expect(delivered!.recipients).toEqual(['hocsinh@truong.example']);
    expect(delivered!.mailFrom).toBe('no-reply@duckoj.example');

    const { headers, body } = parseMessage(delivered!.raw);
    expect(headers['to']).toContain('hocsinh@truong.example');
    expect(decodeHeader(headers['from'] ?? '')).toBe('DuckOJ <no-reply@duckoj.example>');
    expect(decodeHeader(headers['subject'] ?? '')).toBe('Đặt lại mật khẩu DuckOJ của bạn');

    const text = decodeBody(headers, body);
    expect(text).toContain('https://oj.example/reset-password?token=abc');
    expect(text).toContain('Có người vừa yêu cầu đặt lại mật khẩu');
    expect(text).toContain('hết hạn sau 60 phút');
  });

  it('sends the English one to an account whose locale says so (D57)', async () => {
    const mailer = new SmtpMailer(configPointingAtTheListener());
    await mailer.send({
      to: 'student@school.example',
      ...emailVerificationMail('en', { url: 'https://oj.example/verify-email?token=xyz', ttlHours: 24 }),
    });

    const delivered = server.delivered.at(-1)!;
    expect(delivered.recipients).toEqual(['student@school.example']);
    const { headers, body } = parseMessage(delivered.raw);
    const subject = decodeHeader(headers['subject'] ?? '');
    expect(subject).toBe('Confirm your DuckOJ email address');
    // The language is the assertion, not just the subject line: a template
    // that fell back to Vietnamese would still have an English subject if
    // only the subject were checked.
    expect(decodeBody(headers, body)).toContain('Confirm this address');
  });

  it('carries a MAIL_FROM the operator set, not the schema default', async () => {
    const mailer = new SmtpMailer(
      configPointingAtTheListener({ MAIL_FROM: 'Tỉnh OJ <oj@so-gd.example>' }),
    );
    await mailer.send({ to: 'a@b.example', subject: 'Kiểm tra', text: 'xin chào' });
    const delivered = server.delivered.at(-1)!;
    expect(delivered.mailFrom).toBe('oj@so-gd.example');
    expect(decodeHeader(parseMessage(delivered.raw).headers['from'] ?? '')).toBe(
      'Tỉnh OJ <oj@so-gd.example>',
    );
  });

  it('surfaces the transport\'s own error text when the host will not talk', async () => {
    // What the admin test-mail action reports verbatim (D156): an operator
    // debugging a firewall or a TLS mismatch needs the real message, and
    // "failed" would send them nowhere.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const address = closed.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      closed.close((error) => (error ? reject(error) : resolve())),
    );

    const mailer = new SmtpMailer(configPointingAtTheListener({ SMTP_PORT: String(port) }));
    await expect(
      mailer.send({ to: 'a@b.example', subject: 'x', text: 'y' }),
    ).rejects.toThrow(/ECONNREFUSED|connect/i);
  });
});

/**
 * D156 — the admin "send a test mail" action, over the same listener.
 *
 * `sendTestMail` touches no table, so the database handle is a proxy that
 * throws on any access: if this ever grows a query, these cases say so
 * immediately rather than silently needing a container.
 */
const forbiddenDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`sendTestMail touched the database (.${String(property)})`);
    },
  },
) as unknown as Db;

const REDIS_UP: RedisHealth = { reachable: () => Promise.resolve(true) };

function admin(): Actor {
  return { userId: 1, globalRole: 'admin', via: 'session', scopes: [] };
}

function serviceWith(config: AppConfig, mailer: Mailer): DashboardService {
  return new DashboardService(forbiddenDb, REDIS_UP, config, mailer);
}

describe('the admin test-mail action (D156)', () => {
  it('actually delivers, to the address the admin typed', async () => {
    const config = configPointingAtTheListener();
    const before = server.delivered.length;
    const result = await serviceWith(config, new SmtpMailer(config)).sendTestMail(
      admin(),
      'quantri@so-gd.example',
    );

    expect(result).toEqual({ delivered: true, error: null });
    expect(server.delivered.length - before).toBe(1);
    const delivered = server.delivered.at(-1)!;
    expect(delivered.recipients).toEqual(['quantri@so-gd.example']);
    // Bilingual, because the person who receives it may be either (D18) and
    // a test mail with no words in the reader's language proves less.
    const { headers, body } = parseMessage(delivered.raw);
    const text = decodeBody(headers, body);
    expect(text).toContain('kiểm tra cấu hình SMTP');
    expect(text).toContain('test the SMTP configuration');
  });

  it("reports the transport's own error text, verbatim, rather than 'failed'", async () => {
    // A port nothing is listening on. The string an operator needs is
    // `ECONNREFUSED 127.0.0.1:<port>` — it names the host, the port and the
    // kernel's verdict, and every one of those three is the next thing to
    // check. Anything paraphrased here is a debugging session lost.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const address = closed.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      closed.close((error) => (error ? reject(error) : resolve())),
    );

    const config = configPointingAtTheListener({ SMTP_PORT: String(port) });
    const result = await serviceWith(config, new SmtpMailer(config)).sendTestMail(
      admin(),
      'quantri@so-gd.example',
    );

    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.error).toContain(String(port));
  });

  it('refuses with 503 when there is no SMTP host to test', async () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '3000',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      TOTP_ENC_KEY: 'a'.repeat(64),
      PUBLIC_ORIGIN: 'https://oj.example',
      SMTP_HOST: '',
    });
    const service = serviceWith(config, new LogMailer());
    await expect(service.sendTestMail(admin(), 'quantri@so-gd.example')).rejects.toMatchObject({
      status: 503,
      code: 'mail_unavailable',
    });
  });

  it('is admin-only, and refuses before it opens anything', async () => {
    const config = configPointingAtTheListener();
    const before = server.delivered.length;
    const service = serviceWith(config, new SmtpMailer(config));
    const notAnAdmin: Actor = { userId: 2, globalRole: 'user', via: 'session', scopes: [] };
    await expect(service.sendTestMail(notAnAdmin, 'anyone@example.com')).rejects.toBeInstanceOf(
      AppError,
    );
    expect(server.delivered.length).toBe(before);
  });
});

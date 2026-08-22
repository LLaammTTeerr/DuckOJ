/**
 * Sending mail. One port, two transports, no provider SDK.
 *
 * D1 allowed Resend or plain SMTP; Resend publishes SMTP credentials, so a
 * single SMTP implementation satisfies both and the provider becomes a matter
 * of configuration. Adding an SDK would tie the codebase to one vendor for no
 * capability we use.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';

export interface OutboundEmail {
  to: string;
  subject: string;
  /** Plain text only. No HTML, no images, no tracking (3f §6). */
  text: string;
}

export const MAILER = Symbol('MAILER');

export interface Mailer {
  send(message: OutboundEmail): Promise<void>;
  /** Which transport this is, for `readyz` and the boot log. */
  readonly kind: 'smtp' | 'log';
}

@Injectable()
export class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly transport: Transporter;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    const smtp = config.smtp;
    if (!smtp) throw new Error('SmtpMailer constructed without SMTP configuration');
    this.transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.user === undefined
        ? {}
        : { auth: { user: smtp.user, pass: smtp.password ?? '' } }),
    });
    this.logger.log(`mail transport: smtp ${smtp.host}:${String(smtp.port)}`);
  }

  async send(message: OutboundEmail): Promise<void> {
    await this.transport.sendMail({
      from: this.config.mailFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/**
 * The transport used when no SMTP host is configured.
 *
 * **This is the default, and it is deliberate, not a fallback for a
 * misconfiguration.** A developer must not have to stand up a mail server to
 * register a user, and a test must not either. What would be unacceptable is
 * silently dropping mail in production, so it announces itself at boot and
 * `readyz` reports which transport is live.
 */
@Injectable()
export class LogMailer implements Mailer {
  readonly kind = 'log' as const;
  private readonly logger = new Logger(LogMailer.name);
  /** Every message sent this process. Read by tests; unbounded by design in dev. */
  readonly sent: OutboundEmail[] = [];

  constructor() {
    this.logger.warn('mail transport: log — no SMTP_HOST configured, mail will not be delivered');
  }

  send(message: OutboundEmail): Promise<void> {
    this.sent.push(message);
    this.logger.log(`[mail] to=${message.to} subject=${message.subject}\n${message.text}`);
    return Promise.resolve();
  }
}

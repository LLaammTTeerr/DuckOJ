import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { LogMailer, MAILER, SmtpMailer, type Mailer } from './mailer.js';

/**
 * `@Global()` so any module can inject `MAILER` without threading an import
 * through — mail is infrastructure, like the database handle, and
 * `ConfigModule` is already global for the same reason.
 */
@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Mailer =>
        // Falsy, not `=== null`: a config object assembled by hand (a test
        // harness, a script) can leave the field off entirely, and
        // `undefined === null` is false — which would construct an SMTP
        // transport with no host and fail at boot.
        config.smtp ? new SmtpMailer(config) : new LogMailer(),
    },
  ],
  exports: [MAILER],
})
export class MailModule {}

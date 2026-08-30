import { Module } from '@nestjs/common';
import { APP_CONFIG, ConfigModule } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import {
  NullStatementRenderer,
  STATEMENT_RENDERER,
  TypstStatementRenderer,
} from './statement-renderer.js';

/**
 * The statement renderer, in one place.
 *
 * It was a provider inside `ProblemsModule` until the contest booklet (D48)
 * needed the same port from `ContestsModule`. Two `useFactory` copies of
 * "config decides the adapter" is two places for `typstBin: null` to stop
 * meaning 501, so the factory moved here and both controllers import this.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      // The Mailer pattern: config decides the adapter, the controller
      // sees only the port. `typstBin: null` → an honest 501.
      provide: STATEMENT_RENDERER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.typstBin === null
          ? new NullStatementRenderer()
          : new TypstStatementRenderer(config.typstBin),
    },
  ],
  exports: [STATEMENT_RENDERER],
})
export class StatementsModule {}

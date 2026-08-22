import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import {
  NullStatementRenderer,
  STATEMENT_RENDERER,
  TypstStatementRenderer,
} from '../statements/statement-renderer.js';
import { ProblemsController } from './problems.controller.js';

@Module({
  imports: [AuthnModule, AuthzModule],
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
  controllers: [ProblemsController],
})
export class ProblemsModule {}

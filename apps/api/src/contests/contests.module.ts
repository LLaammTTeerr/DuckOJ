import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { StatementsModule } from '../statements/statements.module.js';
import { ContestsController } from './contests.controller.js';
import { ContestResultsService } from './results.service.js';

@Module({
  imports: [AuthnModule, AuthzModule, StatementsModule],
  controllers: [ContestsController],
  // Provided here rather than in `AuthzModule`: it decides nothing about
  // visibility — it asks `ContestAccessService` and `canRunContest` — so it
  // belongs beside the controller it serves (D71).
  providers: [ContestResultsService],
})
export class ContestsModule {}

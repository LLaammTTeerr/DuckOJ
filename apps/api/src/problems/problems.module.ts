import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { PackagesModule } from '../packages/packages.module.js';
import { StatementsModule } from '../statements/statements.module.js';
import { ProblemsController } from './problems.controller.js';
import { ProblemDraftsController } from './problem-drafts.controller.js';
import { ProblemDraftsService } from './problem-drafts.service.js';
import { DraftSweeper } from './draft.sweeper.js';

@Module({
  // `PackagesModule` for `PackagesService` and `DRAFT_STORE` (D87): a draft
  // build stores its package through the same `upload` an archive uploaded to
  // `POST /packages` goes through. `AuthzModule` already imports
  // `PackagesModule` too, and neither imports this one, so the graph stays
  // acyclic without a `forwardRef`.
  imports: [AuthnModule, AuthzModule, PackagesModule, StatementsModule],
  controllers: [ProblemsController, ProblemDraftsController],
  // `DraftSweeper` owns a timer and a lifecycle, on `ExpiredRowsSweeper`'s
  // precedent; it is a provider nothing injects, constructed for its
  // `onApplicationBootstrap` alone.
  providers: [ProblemDraftsService, DraftSweeper],
})
export class ProblemsModule {}

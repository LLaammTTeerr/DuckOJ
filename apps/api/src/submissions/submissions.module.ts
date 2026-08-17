import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { SubmissionAccessService } from '../authz/submission.access.js';
import { SubmissionsController } from './submissions.controller.js';

@Module({
  imports: [AuthnModule],
  controllers: [SubmissionsController],
  providers: [SubmissionAccessService],
  // Task 11's WebSocket gateway authorizes each subscription through this
  // service, so it must be resolvable outside this module.
  exports: [SubmissionAccessService],
})
export class SubmissionsModule {}

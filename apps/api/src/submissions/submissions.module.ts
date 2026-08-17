import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { SubmissionAccessService } from '../authz/submission.access.js';
import { SubmissionsController } from './submissions.controller.js';

@Module({
  imports: [AuthnModule],
  controllers: [SubmissionsController],
  providers: [SubmissionAccessService],
})
export class SubmissionsModule {}

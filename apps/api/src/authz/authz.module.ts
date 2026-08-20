import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { OrgAccessService } from './org.access.js';
import { ProblemAccessService } from './problem.access.js';

@Module({
  imports: [ConfigModule],
  providers: [OrgAccessService, ProblemAccessService],
  exports: [OrgAccessService, ProblemAccessService],
})
export class AuthzModule {}

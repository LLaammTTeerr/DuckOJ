import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { OrgAccessService } from './org.access.js';

@Module({
  imports: [ConfigModule],
  providers: [OrgAccessService],
  exports: [OrgAccessService],
})
export class AuthzModule {}

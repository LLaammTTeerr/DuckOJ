import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthnModule } from './authn/authn.module.js';
import { AuthzModule } from './authz/authz.module.js';
import { OrgsModule } from './orgs/orgs.module.js';
import { ProblemsModule } from './problems/problems.module.js';
import { SubmissionsModule } from './submissions/submissions.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { PackagesModule } from './packages/packages.module.js';

@Module({
  imports: [
    ConfigModule,
    HealthModule,
    AuthnModule,
    AuthzModule,
    OrgsModule,
    ProblemsModule,
    SubmissionsModule,
    RealtimeModule,
    PackagesModule,
  ],
})
export class AppModule {}

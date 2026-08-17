import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthnModule } from './authn/authn.module.js';
import { AuthzModule } from './authz/authz.module.js';
import { OrgsModule } from './orgs/orgs.module.js';

@Module({ imports: [ConfigModule, HealthModule, AuthnModule, AuthzModule, OrgsModule] })
export class AppModule {}

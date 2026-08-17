import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthnModule } from './authn/authn.module.js';

@Module({ imports: [ConfigModule, HealthModule, AuthnModule] })
export class AppModule {}

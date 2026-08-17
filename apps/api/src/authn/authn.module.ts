import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { AuthGuard } from './auth.guard.js';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, SessionService, AuthGuard],
  exports: [AuthService, PasswordService, SessionService, AuthGuard],
})
export class AuthnModule {}

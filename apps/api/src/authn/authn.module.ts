import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TotpController } from './totp.controller.js';
import { TotpService } from './totp.service.js';
import { AuthGuard } from './auth.guard.js';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController, TotpController],
  providers: [AuthService, PasswordService, SessionService, TotpService, AuthGuard],
  exports: [AuthService, PasswordService, SessionService, TotpService, AuthGuard],
})
export class AuthnModule {}

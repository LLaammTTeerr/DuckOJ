import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { TokensController } from './tokens.controller.js';
import { TotpController } from './totp.controller.js';
import { TotpService } from './totp.service.js';
import { AuthGuard } from './auth.guard.js';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController, TotpController, TokensController],
  providers: [AuthService, PasswordService, SessionService, TokenService, TotpService, AuthGuard],
  exports: [AuthService, PasswordService, SessionService, TokenService, TotpService, AuthGuard],
})
export class AuthnModule {}

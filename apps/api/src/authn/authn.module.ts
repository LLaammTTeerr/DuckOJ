import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService],
  exports: [AuthService, PasswordService],
})
export class AuthnModule {}

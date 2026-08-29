import { Body, Controller, Delete, HttpCode, Inject, Post } from '@nestjs/common';
import {
  TotpConfirmRequest,
  TotpRecoveryRegenerateRequest,
  type TotpConfirmRequestDto,
  type TotpRecoveryCodesResponseDto,
  type TotpRecoveryRegenerateRequestDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import type { Actor } from '../authz/actor.js';
import { CurrentActor } from './auth.guard.js';
import { SessionOnly } from './session-only.guard.js';
import { TotpService } from './totp.service.js';

// Every route here rewrites the caller's second factor — `begin` in particular
// upserts a new secret with `confirmedAt: null`, which silently disables an
// existing 2FA enrolment. A bearer token must not reach any of them.
@Controller('auth/totp')
@SessionOnly()
export class TotpController {
  constructor(@Inject(TotpService) private readonly totp: TotpService) {}

  @Post('begin')
  @HttpCode(200)
  begin(@CurrentActor() actor: Actor): Promise<{ secret: string; otpauthUrl: string }> {
    return this.totp.beginEnrolment(actor.userId);
  }

  /**
   * 200, not 204: D39 makes this the one and only delivery of the account's
   * recovery codes, so it has a body. A client that ignores it leaves the
   * user with a second factor and no way past it.
   */
  @Post('confirm')
  @HttpCode(200)
  async confirm(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(TotpConfirmRequest)) body: TotpConfirmRequestDto,
  ): Promise<TotpRecoveryCodesResponseDto> {
    return { recoveryCodes: await this.totp.confirmEnrolment(actor.userId, body.code) };
  }

  @Post('recovery/regenerate')
  @HttpCode(200)
  async regenerateRecoveryCodes(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(TotpRecoveryRegenerateRequest))
    body: TotpRecoveryRegenerateRequestDto,
  ): Promise<TotpRecoveryCodesResponseDto> {
    return { recoveryCodes: await this.totp.regenerateRecoveryCodes(actor.userId, body.code) };
  }

  @Delete()
  @HttpCode(204)
  disable(@CurrentActor() actor: Actor): Promise<void> {
    return this.totp.disable(actor.userId);
  }
}

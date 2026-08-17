import { Body, Controller, Delete, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import type { Actor } from '../authz/actor.js';
import { CurrentActor } from './auth.guard.js';
import { SessionOnlyGuard } from './session-only.guard.js';
import { TotpService } from './totp.service.js';

const ConfirmRequest = z.object({ code: z.string().regex(/^\d{6}$/) });

// Every route here rewrites the caller's second factor — `begin` in particular
// upserts a new secret with `confirmedAt: null`, which silently disables an
// existing 2FA enrolment. A bearer token must not reach any of them.
@Controller('auth/totp')
@UseGuards(SessionOnlyGuard)
export class TotpController {
  constructor(@Inject(TotpService) private readonly totp: TotpService) {}

  @Post('begin')
  @HttpCode(200)
  begin(@CurrentActor() actor: Actor): Promise<{ secret: string; otpauthUrl: string }> {
    return this.totp.beginEnrolment(actor.userId);
  }

  @Post('confirm')
  @HttpCode(204)
  confirm(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(ConfirmRequest)) body: z.infer<typeof ConfirmRequest>,
  ): Promise<void> {
    return this.totp.confirmEnrolment(actor.userId, body.code);
  }

  @Delete()
  @HttpCode(204)
  disable(@CurrentActor() actor: Actor): Promise<void> {
    return this.totp.disable(actor.userId);
  }
}

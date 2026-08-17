import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CreateTokenRequest, type CreateTokenRequestDto } from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import type { Actor } from '../authz/actor.js';
import { AuthGuard, CurrentActor, requireActor } from './auth.guard.js';
import { TokenService } from './token.service.js';

@Controller('auth/tokens')
@UseGuards(AuthGuard)
export class TokensController {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentActor() actor: Actor | null,
    @Body(new ZodValidationPipe(CreateTokenRequest)) body: CreateTokenRequestDto,
  ): Promise<{ id: number; token: string }> {
    return this.tokens.issue(
      requireActor(actor).userId,
      body.name,
      body.scopes,
      body.expiresAt ? new Date(body.expiresAt) : undefined,
    );
  }

  @Get()
  list(@CurrentActor() actor: Actor | null) {
    return this.tokens.list(requireActor(actor).userId);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(
    @CurrentActor() actor: Actor | null,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.tokens.revoke(requireActor(actor).userId, id);
  }
}

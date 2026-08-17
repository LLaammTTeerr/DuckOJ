import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  CreateTokenRequest,
  type CreateTokenRequestDto,
  type CreateTokenResponseDto,
  type TokenSummaryDto,
} from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import type { Actor } from '../authz/actor.js';
import { CurrentActor } from './auth.guard.js';
import { TokenService } from './token.service.js';

@Controller('auth/tokens')
export class TokensController {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(CreateTokenRequest)) body: CreateTokenRequestDto,
  ): Promise<CreateTokenResponseDto> {
    return this.tokens.issue(
      actor.userId,
      body.name,
      body.scopes,
      body.expiresAt ? new Date(body.expiresAt) : undefined,
    );
  }

  @Get()
  list(@CurrentActor() actor: Actor): Promise<TokenSummaryDto[]> {
    return this.tokens.list(actor.userId);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(@CurrentActor() actor: Actor, @Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.tokens.revoke(actor.userId, id);
  }
}

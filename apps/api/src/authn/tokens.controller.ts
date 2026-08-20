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
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import type { Actor } from '../authz/actor.js';
import { CurrentActor } from './auth.guard.js';
import { SessionOnly } from './session-only.guard.js';
import { TokenService } from './token.service.js';

// Applied to the whole controller, not per handler: minting, listing and
// revoking tokens are all credential management, and a class-level guard means
// the next route added here is covered by default rather than by remembering.
// A leaked access token must not be able to mint its own replacements.
@Controller('auth/tokens')
@SessionOnly()
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

import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { RegisterRequest, type MeResponseDto, type RegisterRequestDto } from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { AuthService } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('register')
  @HttpCode(201)
  register(
    @Body(new ZodValidationPipe(RegisterRequest)) body: RegisterRequestDto,
  ): Promise<MeResponseDto> {
    return this.auth.register(body);
  }
}

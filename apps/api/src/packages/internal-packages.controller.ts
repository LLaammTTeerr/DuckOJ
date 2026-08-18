import { Controller, Get, Inject, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PackageHash } from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { JudgeGuard, JudgeRoute } from '../authn/judge.guard.js';
import { PackagesService } from './packages.service.js';

/**
 * Machine-to-machine only: a judge fetches package bytes here before
 * grading. Deliberately excluded from `packages/contracts`'s OpenAPI
 * registry and therefore from the generated SDK — a user session must never
 * be able to reach this route.
 *
 * `@JudgeRoute()` and `@UseGuards(JudgeGuard)` are both required, and
 * neither alone is sufficient — see `auth.guard.ts` and `judge.guard.ts` for
 * why. No `@Public()`: this route is exactly as authenticated as any route
 * without it, just via a judge credential instead of a session.
 */
@Controller('internal/packages')
export class InternalPackagesController {
  constructor(@Inject(PackagesService) private readonly packages: PackagesService) {}

  @Get(':hash/archive')
  @JudgeRoute()
  @UseGuards(JudgeGuard)
  async archive(
    @Param('hash', new ZodValidationPipe(PackageHash)) hash: string,
    @Res() res: Response,
  ): Promise<void> {
    const bytes = await this.packages.getArchiveBytes(hash);
    res.status(200).type('application/octet-stream').send(bytes);
  }
}

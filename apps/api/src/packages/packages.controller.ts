import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  PackageHash,
  UploadPackageQuery,
  type PackageSummaryDto,
  type UploadPackageResponseDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { AppError } from '../common/app.error.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { PackagesService } from './packages.service.js';

/**
 * The body is the raw archive bytes, not JSON, so it cannot go through
 * `ZodValidationPipe`/a Nest body parser: neither of Nest's default parsers
 * (`json`, `urlencoded`) touches the request stream for a non-matching
 * `Content-Type`, so it reaches the handler untouched and is read here
 * directly. Bounded, so a caller cannot force unbounded buffering by simply
 * not stopping.
 *
 * On an over-limit upload this stops *accumulating* (`req.pause()`) but
 * deliberately does not `req.destroy()` the socket immediately: `req` and
 * `res` share one connection, and destroying it before the rejection has
 * propagated through Nest's exception handling means `ProblemFilter` never
 * gets a chance to write a response on it — the caller sees a bare
 * `socket hang up`, not the `413` the route is supposed to answer with. The
 * socket is destroyed only once the response has actually finished writing,
 * to drop whatever excess bytes are still arriving.
 */
function readRawBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        req.pause();
        req.res?.once('finish', () => req.destroy());
        reject(new AppError(413, 'package_too_large', `The archive exceeds the ${limit}-byte upload limit.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

// Deliberately no @Public(): both routes require authentication, and the
// global guard rejects by default if the marker is simply absent.
@Controller('packages')
export class PackagesController {
  constructor(
    @Inject(PackagesService) private readonly packages: PackagesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @HttpCode(201)
  async upload(
    @Query(new ZodValidationPipe(UploadPackageQuery)) query: { hash: string },
    @Req() req: Request,
  ): Promise<UploadPackageResponseDto> {
    const archive = await readRawBody(req, this.config.packageUploadMaxBytes);
    return this.packages.upload(query.hash, archive);
  }

  @Get(':hash')
  get(@Param('hash', new ZodValidationPipe(PackageHash)) hash: string): Promise<PackageSummaryDto> {
    return this.packages.getSummary(hash);
  }
}

import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  PackageHash,
  UploadPackageQuery,
  type PackageSummaryDto,
  type UploadPackageResponseDto,
} from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { AppError } from '../common/app.error.js';
import { PackagesService } from './packages.service.js';

/** 256 MiB — generous for problem test data, small enough to bound memory use. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/**
 * The body is the raw archive bytes, not JSON, so it cannot go through
 * `ZodValidationPipe`/a Nest body parser: neither of Nest's default parsers
 * (`json`, `urlencoded`) touches the request stream for a non-matching
 * `Content-Type`, so it reaches the handler untouched and is read here
 * directly. Bounded, so a caller cannot force unbounded buffering by simply
 * not stopping.
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
        req.destroy();
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
  constructor(@Inject(PackagesService) private readonly packages: PackagesService) {}

  @Post()
  @HttpCode(201)
  async upload(
    @Query(new ZodValidationPipe(UploadPackageQuery)) query: { hash: string },
    @Req() req: Request,
  ): Promise<UploadPackageResponseDto> {
    const archive = await readRawBody(req, MAX_UPLOAD_BYTES);
    return this.packages.upload(query.hash, archive);
  }

  @Get(':hash')
  get(@Param('hash', new ZodValidationPipe(PackageHash)) hash: string): Promise<PackageSummaryDto> {
    return this.packages.getSummary(hash);
  }
}

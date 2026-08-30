import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  PackageHash,
  UploadPackageQuery,
  type PackageSummaryDto,
  type UploadPackageResponseDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { readRawBody } from '../common/raw-body.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { PackagesService } from './packages.service.js';

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
  @RequireScope('packages:write')
  async upload(
    @Query(new ZodValidationPipe(UploadPackageQuery)) query: { hash: string },
    @Req() req: Request,
  ): Promise<UploadPackageResponseDto> {
    const archive = await readRawBody(req, this.config.packageUploadMaxBytes, 'package_too_large', 'archive');
    return this.packages.upload(query.hash, archive);
  }

  @Get(':hash')
  @RequireScope('packages:read')
  get(@Param('hash', new ZodValidationPipe(PackageHash)) hash: string): Promise<PackageSummaryDto> {
    return this.packages.getSummary(hash);
  }
}

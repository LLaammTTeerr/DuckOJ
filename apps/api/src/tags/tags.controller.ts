import { Controller, Get, Inject } from '@nestjs/common';
import type { TagListDto } from '@duckoj/contracts';
import { Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import { TagsService } from './tags.service.js';

/**
 * `@Public()` plus `@RequireScope('problems:read')`, exactly like
 * `GET /problems` itself: the filter bar on the problem list has to render
 * the vocabulary before a signed-out visitor has done anything, and a token
 * that may not read problems has no business enumerating the taxonomy they
 * are filed under either. No scope of its own — a thirteenth scope for
 * twenty-five public rows would be ceremony.
 */
@Controller('tags')
export class TagsController {
  constructor(@Inject(TagsService) private readonly tags: TagsService) {}

  @Get()
  @Public()
  @RequireScope('problems:read')
  list(): Promise<TagListDto> {
    return this.tags.listAll();
  }
}

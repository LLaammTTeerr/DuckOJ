import type { PipeTransform } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from './app.error.js';

@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      (fields[key] ??= []).push(issue.message);
    }
    throw new AppError(422, 'validation_failed', 'The request body failed validation.', fields);
  }
}

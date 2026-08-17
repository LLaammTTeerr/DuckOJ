import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from './app.error.js';

/**
 * Nest applies the same pipe to `@Body`, `@Query` and `@Param`, so the failure
 * message has to name the part that actually failed — telling a client that
 * sent `?limit=500` that its *body* is invalid sends it looking in the wrong
 * place. `ArgumentMetadata.type` is how Nest reports which one it is.
 */
const SUBJECT: Record<ArgumentMetadata['type'], string> = {
  body: 'request body',
  query: 'query string',
  param: 'path parameters',
  custom: 'request',
};

@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, metadata?: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      (fields[key] ??= []).push(issue.message);
    }
    const subject = SUBJECT[metadata?.type ?? 'body'] ?? 'request';
    throw new AppError(422, 'validation_failed', `The ${subject} failed validation.`, fields);
  }
}

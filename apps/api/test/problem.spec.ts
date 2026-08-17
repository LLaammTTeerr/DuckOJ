import {
  Body,
  Controller,
  Get,
  HttpException,
  Module,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/common/app.error.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { ZodValidationPipe } from '../src/common/zod.pipe.js';

const Body_ = z.object({ email: z.string().email(), age: z.number().int().min(0) });
const Query_ = z.object({ limit: z.coerce.number().int().min(1).max(100) });

/** Stands in for the argon2id hash `AuthService.register` binds as a parameter. */
const SECRET_PARAM = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$SECRETHASHBYTES';

@Controller('t')
class TestController {
  @Get('boom')
  boom(): never {
    throw new AppError(409, 'org_slug_taken', 'That slug is already in use.');
  }

  @Get('unknown')
  unknown(): never {
    throw new Error('kaboom');
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException();
  }

  @Get('teapot')
  teapot(): never {
    throw new HttpException('short and stout', 418);
  }

  @Get('drizzle')
  drizzle(): never {
    throw new DrizzleQueryError(
      'insert into "users" ("password_hash") values ($1) returning *',
      [SECRET_PARAM],
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );
  }

  @Post('validate')
  validate(@Body(new ZodValidationPipe(Body_)) body: z.infer<typeof Body_>) {
    return body;
  }

  @Get('paged')
  paged(@Query(new ZodValidationPipe(Query_)) query: z.infer<typeof Query_>) {
    return query;
  }
}

@Module({ controllers: [TestController] })
class TestModule {}

describe('problem+json error handling', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it('renders an AppError as problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/t/boom');
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('org_slug_taken');
    expect(res.body.status).toBe(409);
  });

  it('never leaks an internal message', async () => {
    const res = await request(app.getHttpServer()).get('/t/unknown');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain('kaboom');
  });

  it('reports field-level validation failures', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/validate')
      .send({ email: 'nope', age: -1 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.fields.email).toBeDefined();
    expect(res.body.fields.age).toBeDefined();
  });

  it('passes a valid body through unchanged', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/validate')
      .send({ email: 'a@b.com', age: 3 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ email: 'a@b.com', age: 3 });
  });

  it('names the query string, not the body, when a query fails validation', async () => {
    const res = await request(app.getHttpServer()).get('/t/paged?limit=500');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.detail).toContain('query string');
    expect(res.body.detail).not.toContain('body');
  });

  it('takes codes from an explicit table, not from the display title', async () => {
    const res = await request(app.getHttpServer()).get('/t/missing');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    // The title is a display string and may be reworded freely; `code` is the
    // contract and must not be derived from it.
    expect(res.body.title).toBe('Not Found');
  });

  it('gives an unlisted status a distinct stable code rather than a shared one', async () => {
    const res = await request(app.getHttpServer()).get('/t/teapot');
    expect(res.status).toBe(418);
    expect(res.body.code).toBe('http_418');
  });

  it('logs a failed query without its bind parameters', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(app.getHttpServer()).get('/t/drizzle');
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('internal_error');

      // The 500 must still be diagnosable...
      expect(logged).toHaveBeenCalledTimes(1);
      const rendered = JSON.stringify(logged.mock.calls[0]);
      expect(rendered).toContain('DrizzleQueryError');
      expect(rendered).toContain('40P01');
      expect(rendered).toContain('problem.spec.ts');

      // ...without the password hash drizzle embeds in the message — and hence
      // in the first line of `.stack`, which is the trap a naive "log the name
      // and the stack" fix walks straight into.
      expect(rendered).not.toContain('SECRETHASHBYTES');
      expect(rendered).not.toContain('argon2id');
      expect(rendered).not.toContain('password_hash');
      expect(JSON.stringify(res.body)).not.toContain('SECRETHASHBYTES');
    } finally {
      logged.mockRestore();
    }
  });
});

import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/common/app.error.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { ZodValidationPipe } from '../src/common/zod.pipe.js';

const Body_ = z.object({ email: z.string().email(), age: z.number().int().min(0) });

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

  @Post('validate')
  validate(@Body(new ZodValidationPipe(Body_)) body: z.infer<typeof Body_>) {
    return body;
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
});

import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ProblemDetailsDto } from '@qhhoj/contracts';
import { AppError } from './app.error.js';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const problem = this.toProblem(exception, req.originalUrl);
    if (problem.status >= 500) this.logger.error(exception);

    res.status(problem.status).type('application/problem+json').send(problem);
  }

  private toProblem(exception: unknown, instance: string): ProblemDetailsDto {
    if (exception instanceof AppError) {
      return {
        type: 'about:blank',
        title: TITLES[exception.status] ?? 'Error',
        status: exception.status,
        code: exception.code,
        instance,
        ...(exception.detail ? { detail: exception.detail } : {}),
        ...(exception.fields ? { fields: exception.fields } : {}),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: 'about:blank',
        title: TITLES[status] ?? 'Error',
        status,
        code: snakeCode(TITLES[status] ?? 'error'),
        instance,
      };
    }
    return {
      type: 'about:blank',
      title: TITLES[500]!,
      status: 500,
      code: 'internal_error',
      instance,
    };
  }
}

function snakeCode(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '_');
}

import { z } from 'zod';
import { Timestamp } from './common.js';
import { registry } from './registry.js';

export const Verdict = z.enum(['AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'IR', 'IE']);

export const CreateSubmissionRequest = z.object({
  problemCode: z.string().min(1).max(64),
  languageKey: z.string().min(1).max(32),
  source: z.string().min(1).max(64 * 1024),
});
export type CreateSubmissionRequestDto = z.infer<typeof CreateSubmissionRequest>;

export const CreateSubmissionResponse = z.object({ id: z.number().int() });
export type CreateSubmissionResponseDto = z.infer<typeof CreateSubmissionResponse>;

export const SubmissionCaseDto = z.object({
  groupIndex: z.number().int(),
  caseIndex: z.number().int(),
  verdict: Verdict.nullable(),
  skipped: z.boolean(),
  timeMs: z.number().int(),
  memoryKb: z.number().int(),
  points: z.number(),
  maxPoints: z.number(),
  feedback: z.string().nullable(),
});

export const SubmissionDetail = z.object({
  id: z.number().int(),
  problemCode: z.string(),
  languageKey: z.string(),
  state: z.enum(['queued', 'compiling', 'grading', 'done', 'errored']),
  verdict: Verdict.nullable(),
  points: z.number().nullable(),
  maxPoints: z.number().nullable(),
  timeMs: z.number().int().nullable(),
  memoryKb: z.number().int().nullable(),
  compileOutput: z.string().nullable(),
  cases: z.array(SubmissionCaseDto),
  createdAt: Timestamp,
  judgedAt: Timestamp.nullable(),
});
export type SubmissionDetailDto = z.infer<typeof SubmissionDetail>;

registry.registerPath({
  method: 'post',
  path: '/submissions',
  summary: 'Submit a solution for grading',
  request: {
    body: { content: { 'application/json': { schema: CreateSubmissionRequest } } },
  },
  responses: {
    201: { description: 'The submission was accepted and queued', content: { 'application/json': { schema: CreateSubmissionResponse } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/submissions/{id}',
  summary: 'A submission visible to the caller',
  request: {
    params: z.object({ id: z.coerce.number().int() }),
  },
  responses: {
    200: { description: 'The submission', content: { 'application/json': { schema: SubmissionDetail } } },
  },
});

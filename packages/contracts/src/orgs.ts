import { z } from 'zod';
import { Timestamp, cursorPage } from './common.js';
import { registry } from './registry.js';

export const OrgSummary = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  about: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  joinPolicy: z.enum(['open', 'request', 'invite']),
  createdAt: Timestamp,
});
export type OrgSummaryDto = z.infer<typeof OrgSummary>;

export const OrgPage = cursorPage(OrgSummary);
export type OrgPageDto = z.infer<typeof OrgPage>;

registry.registerPath({
  method: 'get',
  path: '/orgs',
  summary: 'Organizations visible to the caller',
  responses: {
    200: { description: 'A page of organizations', content: { 'application/json': { schema: OrgPage } } },
  },
});

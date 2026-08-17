import { z } from 'zod';
import { Timestamp } from './common.js';

export const CreateTokenRequest = z.object({
  name: z.string().min(1).max(64),
  scopes: z.array(z.string()).default([]),
  expiresAt: Timestamp.optional(),
});
export type CreateTokenRequestDto = z.infer<typeof CreateTokenRequest>;

export const CreateTokenResponse = z.object({
  id: z.number().int(),
  /** Returned exactly once, at creation. */
  token: z.string(),
});

export const TokenSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
});

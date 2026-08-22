import { z } from 'zod';
import { ProblemDetails, Timestamp } from './common.js';
import { registry } from './registry.js';

/**
 * In-app notifications (D14). Session-only, like `/auth/tokens`: they are a
 * signed-in person's UI surface, and an access token has no business reading
 * them.
 *
 * `kind` is an open string with a jsonb `payload` beside it — the server
 * adds kinds without a contract change, and a client renders the kinds it
 * knows and falls back to `kind` itself for ones it does not.
 */
export const Notification = z.object({
  id: z.number().int(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  readAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type NotificationDto = z.infer<typeof Notification>;

export const NotificationList = z.object({
  /** Newest first, capped at 50 — a notification feed, not an archive. */
  items: z.array(Notification),
  unreadCount: z.number().int(),
});
export type NotificationListDto = z.infer<typeof NotificationList>;

const NOT_SIGNED_IN = {
  description: 'Not signed in',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};
const SESSION_ONLY = {
  description: 'Authenticated by an access token rather than an interactive session (`session_required`)',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

registry.registerPath({
  method: 'get',
  path: '/notifications',
  tags: ['Notifications'],
  summary: 'Your notifications, newest first, with the unread count',
  responses: {
    200: { description: 'The feed', content: { 'application/json': { schema: NotificationList } } },
    401: NOT_SIGNED_IN,
    403: SESSION_ONLY,
  },
});

registry.registerPath({
  method: 'post',
  path: '/notifications/read',
  tags: ['Notifications'],
  summary: 'Mark every notification read',
  responses: {
    200: { description: 'The now-empty unread count', content: { 'application/json': { schema: NotificationList } } },
    401: NOT_SIGNED_IN,
    403: SESSION_ONLY,
  },
});

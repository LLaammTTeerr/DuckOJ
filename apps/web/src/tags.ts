import type { paths } from '@duckoj/sdk';
import { api } from './api.js';

export type Tag = paths['/tags']['get']['responses'][200]['content']['application/json']['items'][number];

/**
 * `GET /tags`, as a shared query-options object for the same reason
 * `meQueryOptions` is one: three screens need the vocabulary (the problem
 * list's filter bar, the edit form's checkboxes, and any future picker), and
 * they must read one cached `['tags']` entry rather than each fetching their
 * own copy of a table that changes only when a migration changes it.
 *
 * `staleTime: Infinity` for that same reason — the list is seeded by
 * migration 0018 and has no write path at all, so a refetch could only ever
 * return what is already in the cache.
 */
export const tagsQueryOptions = {
  queryKey: ['tags'] as const,
  queryFn: async (): Promise<Tag[]> => {
    const { data } = await api.GET('/tags');
    return data?.items ?? [];
  },
  staleTime: Infinity,
};

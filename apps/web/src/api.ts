import { API_PREFIX } from '@duckoj/api-prefix';
import { createClient } from '@duckoj/sdk';

// The literal used to live here independently of apps/api's own
// `setGlobalPrefix` call — see @duckoj/api-prefix's doc comment for why
// that drifted once (apps/judge-agent's materializer.ts silently omitted
// the prefix entirely, undetected until an actual bring-up).
export const api = createClient({
  baseUrl: `${import.meta.env.VITE_API_ORIGIN ?? ''}/${API_PREFIX}`,
});

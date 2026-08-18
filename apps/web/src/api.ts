import { API_PREFIX } from '@qhhoj/api-prefix';
import { createClient } from '@qhhoj/sdk';

// The literal used to live here independently of apps/api's own
// `setGlobalPrefix` call — see @qhhoj/api-prefix's doc comment for why
// that drifted once (apps/judge-agent's materializer.ts silently omitted
// the prefix entirely, undetected until an actual bring-up).
export const api = createClient({
  baseUrl: `${import.meta.env.VITE_API_ORIGIN ?? ''}/${API_PREFIX}`,
});

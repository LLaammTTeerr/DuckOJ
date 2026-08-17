import { createClient } from '@qhhoj/sdk';

export const api = createClient({
  baseUrl: `${import.meta.env.VITE_API_ORIGIN ?? ''}/api/v1`,
});

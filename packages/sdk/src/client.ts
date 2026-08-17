import createOpenApiClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated.js';

export interface ClientOptions {
  baseUrl: string;
  /** Personal access token for SDK/CLI use. Browsers rely on the session cookie instead. */
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export function createClient(options: ClientOptions) {
  const client = createOpenApiClient<paths>({
    baseUrl: options.baseUrl,
    credentials: 'include',
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  if (options.token) {
    const auth: Middleware = {
      onRequest({ request }) {
        request.headers.set('authorization', `Bearer ${options.token}`);
        return request;
      },
    };
    client.use(auth);
  }

  return client;
}

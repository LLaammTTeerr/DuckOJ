import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { API_PREFIX } from '@duckoj/api-prefix';

export const registry = new OpenAPIRegistry();

export function openApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'DuckOJ API', version: '1.0.0' },
    servers: [{ url: API_PREFIX }],
  });
}

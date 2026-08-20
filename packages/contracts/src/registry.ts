import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { API_PREFIX } from '@duckoj/api-prefix';

export const registry = new OpenAPIRegistry();

export function openApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'DuckOJ API', version: '1.0.0' },
    // Root-relative, hence the leading slash: `API_PREFIX` is deliberately
    // bare (`api/v1`) because `setGlobalPrefix` wants it that way, but a
    // *relative* OpenAPI server URL resolves against the location the
    // document was served from. Serve the document at `/docs/openapi.json`
    // and a bare `api/v1` would send every "try it" request to
    // `/docs/api/v1`. Deriving from the constant keeps the single source of
    // truth; the slash makes the result unambiguous wherever it is hosted.
    servers: [{ url: `/${API_PREFIX}` }],
  });
}

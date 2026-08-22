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
    // Display order in the reference. Every registered route carries exactly
    // one of these — `test/tags.spec.ts` walks the document and fails on an
    // untagged route or an unknown tag, so this list cannot drift from the
    // routes silently.
    tags: [
      { name: 'Auth', description: 'Sessions, registration, recovery, two-factor' },
      { name: 'API tokens', description: 'Personal access tokens for the SDK and the oj CLI' },
      { name: 'Users', description: 'Public profiles and rating history' },
      { name: 'Problems', description: 'Problems, revisions and statements' },
      { name: 'Submissions', description: 'Submitting and reading verdicts' },
      { name: 'Contests', description: 'Contests, participation and scoreboards' },
      { name: 'Organizations', description: 'Membership, join requests and roles' },
      { name: 'Notifications', description: 'The signed-in notification feed' },
      { name: 'Packages', description: 'Content-addressed problem packages' },
      { name: 'Languages', description: 'Submission languages' },
      { name: 'Admin', description: 'Session-only administration' },
      { name: 'Meta', description: 'The API reference and this document' },
    ],
  });
}

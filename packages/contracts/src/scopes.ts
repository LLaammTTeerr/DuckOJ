export const SCOPES = [
  'problems:read',
  'problems:write',
  'problems:publish',
  'submissions:read',
  'submissions:write',
  'orgs:read',
  'packages:read',
  'packages:write',
  'languages:read',
] as const;
export type Scope = (typeof SCOPES)[number];

// Structural, not `Actor` from apps/api: this package is bundled into the
// browser and must not depend on any workspace package.
export function hasScope(actor: { via: 'session' | 'token'; scopes: string[] }, required: Scope): boolean {
  // Branch on `via`, NOT on scopes.length — a session's [] means "unrestricted
  // human" and a token's [] means "declared no permissions". Same value,
  // opposite meanings; keying on emptiness gets one of them wrong.
  if (actor.via === 'session') return true;
  return actor.scopes.includes(required);
}

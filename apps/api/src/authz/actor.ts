export interface Actor {
  userId: number;
  globalRole: 'user' | 'setter' | 'admin';
  via: 'session' | 'token';
  scopes: string[];
}

export function isAdmin(actor: Actor | null): boolean {
  return actor?.globalRole === 'admin';
}

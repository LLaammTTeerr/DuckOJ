/**
 * `/account/tokens` — mint and revoke the personal access tokens the `oj`
 * CLI signs in with. Session-only server-side; the plaintext appears
 * exactly once, at creation, and this screen says so instead of
 * pretending it could be shown again.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SCOPES } from '@duckoj/contracts';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';

type TokenRow = paths['/auth/tokens']['get']['responses'][200]['content']['application/json'][number];

// The contract's own vocabulary — never a hand-copied list that drifts.
const SCOPE_CHOICES = SCOPES;

export function TokensPage() {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['problems:read', 'submissions:write']);
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One flag for create AND revoke: a double-click on Create mints two live
  // tokens and silently replaces the first plaintext with the second, so the
  // buttons must not fire while a request is in flight.
  const [busy, setBusy] = useState(false);

  const tokens = useQuery({
    queryKey: ['tokens'],
    queryFn: async (): Promise<TokenRow[] | null> => {
      const { data } = await api.GET('/auth/tokens');
      return data ?? null;
    },
  });

  function toggleScope(scope: string): void {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const { data, error: err } = await api.POST('/auth/tokens', {
        body: { name, scopes: scopes as never },
      });
      if (err) {
        setError(err.detail ?? 'Could not create the token.');
        return;
      }
      setError(null);
      setMinted(data.token);
      setName('');
      await client.invalidateQueries({ queryKey: ['tokens'] });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number): Promise<void> {
    setBusy(true);
    try {
      const { error: err } = await api.DELETE('/auth/tokens/{id}', { params: { path: { id } } });
      if (err) {
        setError(err.detail ?? 'Could not revoke the token.');
        return;
      }
      setError(null);
      await client.invalidateQueries({ queryKey: ['tokens'] });
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (tokens.isPending) return <p className="muted">Loading…</p>;
  if (tokens.data == null) return <p>Sign in (with a session, not a token) to manage tokens.</p>;
  const rows = tokens.data;

  return (
    <section className="panel">
      <h1>API tokens</h1>
      <p className="muted">
        For the <code>oj</code> CLI: <code>oj login --url &lt;origin&gt;/api/v1 --token &lt;token&gt;</code>
      </p>

      {minted !== null ? (
        <p role="status">
          {/* Once. The server stores a hash; there is no second showing. */}
          New token (copy it now — it will not be shown again): <code>{minted}</code>
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}

      <h2>Create</h2>
      <p>
        <label>
          Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="laptop-cli" />
        </label>
      </p>
      <p>
        {SCOPE_CHOICES.map((scope) => (
          <label key={scope} style={{ marginRight: '1em' }}>
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={() => toggleScope(scope)}
            />{' '}
            {scope}
          </label>
        ))}
      </p>
      <p>
        <button type="button" disabled={busy || name === ''} onClick={() => void create()}>
          Create token
        </button>
      </p>

      <h2>Existing</h2>
      {rows.length === 0 ? (
        <p className="muted">No tokens.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((token) => (
              <tr key={token.id}>
                <td>{token.name}</td>
                <td>{token.scopes.join(' ') || 'none'}</td>
                <td>{token.lastUsedAt === null ? 'never' : new Date(token.lastUsedAt).toLocaleDateString()}</td>
                <td>
                  <button type="button" disabled={busy} onClick={() => void revoke(token.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

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
import { formatDate, useLocale, useT } from '../i18n/index.js';

type TokenRow = paths['/auth/tokens']['get']['responses'][200]['content']['application/json'][number];

// The contract's own vocabulary — never a hand-copied list that drifts.
const SCOPE_CHOICES = SCOPES;

export function TokensPage() {
  const t = useT();
  const { locale } = useLocale();
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
        setError(err.detail ?? t('tokens.createError'));
        return;
      }
      setError(null);
      setMinted(data.token);
      setName('');
      await client.invalidateQueries({ queryKey: ['tokens'] });
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number): Promise<void> {
    setBusy(true);
    try {
      const { error: err } = await api.DELETE('/auth/tokens/{id}', { params: { path: { id } } });
      if (err) {
        setError(err.detail ?? t('tokens.revokeError'));
        return;
      }
      setError(null);
      await client.invalidateQueries({ queryKey: ['tokens'] });
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  if (tokens.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (tokens.data == null) return <p>{t('tokens.gate')}</p>;
  const rows = tokens.data;

  return (
    <section className="panel">
      <h1>{t('tokens.title')}</h1>
      <p className="muted">
        {t('tokens.cliHintPrefix')}
        <code>oj</code>
        {t('tokens.cliHintSuffix')}
        <code>oj login --url &lt;origin&gt;/api/v1 --token &lt;token&gt;</code>
      </p>

      {minted !== null ? (
        <p role="status">
          {/* Once. The server stores a hash; there is no second showing. */}
          {t('tokens.minted')}
          <code>{minted}</code>
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}

      <h2>{t('tokens.create')}</h2>
      <p>
        <label>
          {t('common.name')} <input value={name} onChange={(e) => setName(e.target.value)} placeholder="laptop-cli" />
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
          {t('tokens.createButton')}
        </button>
      </p>

      <h2>{t('tokens.existing')}</h2>
      {rows.length === 0 ? (
        <p className="muted">{t('tokens.empty')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('tokens.colScopes')}</th>
              <th>{t('tokens.colLastUsed')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((token) => (
              <tr key={token.id}>
                <td>{token.name}</td>
                {/* The scope strings themselves are the contract's own
                    vocabulary (`problems:read`) — identifiers on the wire,
                    never translated. */}
                <td>{token.scopes.join(' ') || t('common.none')}</td>
                <td>
                  {token.lastUsedAt === null
                    ? t('common.never')
                    : formatDate(token.lastUsedAt, locale)}
                </td>
                <td>
                  <button type="button" disabled={busy} onClick={() => void revoke(token.id)}>
                    {t('tokens.revoke')}
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

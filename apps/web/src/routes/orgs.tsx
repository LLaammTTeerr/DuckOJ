/**
 * Organization screens — the UI for what Phase 3e made joinable over HTTP.
 *
 * One deliberate asymmetry against the contests screens: membership is not a
 * separate `/me` endpoint here. The members list is visible to anyone who can
 * see the organization at all (contract note on `OrgMember`), so the viewer's
 * own standing is derived by finding their username in it — one query, and
 * the list and the viewer's role cannot disagree.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';

type Org = paths['/orgs']['get']['responses'][200]['content']['application/json']['items'][number];
type Member = paths['/orgs/{slug}/members']['get']['responses'][200]['content']['application/json'][number];
type JoinRequest =
  paths['/orgs/{slug}/requests']['get']['responses'][200]['content']['application/json'][number];

export function OrgsPage() {
  const query = useQuery({
    queryKey: ['orgs'],
    queryFn: async () => {
      const { data, error } = await api.GET('/orgs', {});
      if (error) throw new Error('Could not load organizations.');
      return data;
    },
  });

  return (
    <section className="panel">
      <h1>Organizations</h1>
      {query.isPending ? <p className="muted">Loading…</p> : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {query.data && query.data.items.length === 0 ? (
        <p className="muted">No organizations yet.</p>
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Organization</th>
              <th>Joining</th>
            </tr>
          </thead>
          <tbody>
            {query.data.items.map((org: Org) => (
              <tr key={org.slug}>
                <td>
                  <Link to="/orgs/$slug" params={{ slug: org.slug }}>
                    {org.name}
                  </Link>
                </td>
                <td>{org.joinPolicy === 'open' ? 'open' : org.joinPolicy === 'request' ? 'on request' : 'invite only'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/** The deciders' queue — rendered only for an owner or admin. */
function RequestsQueue({ slug, onDecided }: { slug: string; onDecided: () => Promise<void> }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const requests = useQuery({
    queryKey: ['org-requests', slug],
    queryFn: async (): Promise<JoinRequest[]> => {
      const { data } = await api.GET('/orgs/{slug}/requests', { params: { path: { slug } } });
      return data ?? [];
    },
  });

  async function decide(id: number, approve: boolean): Promise<void> {
    const path = approve ? '/orgs/{slug}/requests/{id}/approve' : '/orgs/{slug}/requests/{id}/reject';
    const { error: err } = await api.POST(path, { params: { path: { slug, id } } });
    if (err) {
      setError(err.detail ?? 'Could not decide the request.');
      return;
    }
    setError(null);
    await client.invalidateQueries({ queryKey: ['org-requests', slug] });
    await onDecided();
  }

  if (!requests.data || requests.data.length === 0) return null;
  return (
    <>
      <h2>Join requests</h2>
      {error ? <p role="alert">{error}</p> : null}
      <table>
        <tbody>
          {requests.data.map((req) => (
            <tr key={req.id}>
              <td>
                <Link to="/users/$username" params={{ username: req.username }}>
                  {req.username}
                </Link>
              </td>
              <td>
                <button type="button" onClick={() => void decide(req.id, true)}>
                  Approve
                </button>{' '}
                <button type="button" onClick={() => void decide(req.id, false)}>
                  Reject
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function OrgPage({ slug }: { slug: string }) {
  const client = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const me = useQuery(meQueryOptions);
  const org = useQuery({
    queryKey: ['org', slug],
    queryFn: async () => {
      const { data, error } = await api.GET('/orgs/{slug}', { params: { path: { slug } } });
      if (error) throw new Error(error.detail ?? 'No such organization.');
      return data;
    },
  });
  const members = useQuery({
    queryKey: ['org-members', slug],
    queryFn: async (): Promise<Member[]> => {
      const { data } = await api.GET('/orgs/{slug}/members', { params: { path: { slug } } });
      return data ?? [];
    },
  });

  async function refresh(): Promise<void> {
    await client.invalidateQueries({ queryKey: ['org-members', slug] });
  }

  async function join(): Promise<void> {
    const { data, error } = await api.POST('/orgs/{slug}/join', { params: { path: { slug } } });
    if (error) {
      setActionError(error.detail ?? 'Could not join.');
      return;
    }
    setActionError(null);
    if (data.outcome === 'requested') setRequested(true);
    else await refresh();
  }

  async function leave(username: string): Promise<void> {
    const { error } = await api.DELETE('/orgs/{slug}/members/{username}', {
      params: { path: { slug, username } },
    });
    if (error) {
      setActionError(error.detail ?? 'Could not remove the member.');
      return;
    }
    setActionError(null);
    await refresh();
  }

  async function setRole(username: string, role: Member['role']): Promise<void> {
    const { error } = await api.PATCH('/orgs/{slug}/members/{username}', {
      params: { path: { slug, username } },
      body: { role },
    });
    if (error) {
      setActionError(error.detail ?? 'Could not change the role.');
      return;
    }
    setActionError(null);
    await refresh();
  }

  if (org.isPending) return <p className="muted">Loading…</p>;
  if (org.error) return <p role="alert">{org.error.message}</p>;
  if (!org.data) return null;

  const myName = me.data?.username ?? null;
  const mine = myName === null ? undefined : members.data?.find((m) => m.username === myName);
  const decider = mine !== undefined && (mine.role === 'owner' || mine.role === 'admin');

  return (
    <section className="panel">
      <h1>{org.data.name}</h1>
      <p className="muted">
        {org.data.slug} ·{' '}
        {org.data.joinPolicy === 'open'
          ? 'anyone may join'
          : org.data.joinPolicy === 'request'
            ? 'joining needs approval'
            : 'invite only'}
      </p>
      {org.data.about ? <p>{org.data.about}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      {myName !== null && mine === undefined && !requested && org.data.joinPolicy !== 'invite' ? (
        <p>
          <button type="button" onClick={() => void join()}>
            {org.data.joinPolicy === 'open' ? 'Join' : 'Request to join'}
          </button>
        </p>
      ) : null}
      {requested ? <p>Request sent — an owner or admin decides.</p> : null}

      {decider ? <RequestsQueue slug={slug} onDecided={refresh} /> : null}

      <h2>Members</h2>
      {members.data && members.data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              {decider || mine !== undefined ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {members.data.map((member) => (
              <tr key={member.username}>
                <td>
                  <Link to="/users/$username" params={{ username: member.username }}>
                    {member.username}
                  </Link>
                </td>
                <td>
                  {decider && member.username !== myName ? (
                    <select
                      aria-label={`Role of ${member.username}`}
                      value={member.role}
                      onChange={(e) => void setRole(member.username, e.target.value as Member['role'])}
                    >
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </select>
                  ) : (
                    member.role
                  )}
                </td>
                {decider || mine !== undefined ? (
                  <td>
                    {member.username === myName ? (
                      <button type="button" onClick={() => void leave(member.username)}>
                        Leave
                      </button>
                    ) : decider ? (
                      <button type="button" onClick={() => void leave(member.username)}>
                        Remove
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No visible members.</p>
      )}
    </section>
  );
}

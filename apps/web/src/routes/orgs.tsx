/**
 * Organization screens — the UI for what Phase 3e made joinable over HTTP.
 *
 * One deliberate asymmetry against the contests screens: membership is not a
 * separate `/me` endpoint here. The organization row carries the viewer's own
 * `myRole` (D58), so the viewer's standing is one field on a row already
 * fetched rather than a search through a roster — which matters now that the
 * roster is paged and no longer necessarily contains them.
 */
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { meQueryOptions } from '../me.js';
import { useT, type MsgKey, type TFunction } from '../i18n/index.js';

type Org = paths['/orgs']['get']['responses'][200]['content']['application/json']['items'][number];
type Member =
  paths['/orgs/{slug}/members']['get']['responses'][200]['content']['application/json']['items'][number];
type JoinRequest =
  paths['/orgs/{slug}/requests']['get']['responses'][200]['content']['application/json'][number];

/**
 * The join policy, twice: a short label for a table cell and a full sentence
 * for the org's own header. The POLICY ITSELF stays the API's enum value —
 * these only name it.
 */
type JoinPolicy = Org['joinPolicy'];
const POLICY_SHORT: Record<JoinPolicy, MsgKey> = {
  open: 'joinPolicy.open',
  request: 'joinPolicy.request',
  invite: 'joinPolicy.invite',
};
const POLICY_LONG: Record<JoinPolicy, MsgKey> = {
  open: 'joinPolicy.openLong',
  request: 'joinPolicy.requestLong',
  invite: 'joinPolicy.inviteLong',
};

/** Member roles, likewise: the `<option value>` is the enum, this is the word. */
const ROLE_KEYS: Record<Member['role'], MsgKey> = {
  owner: 'role.owner',
  admin: 'role.admin',
  member: 'role.member',
};
function roleLabel(t: TFunction, role: Member['role']): string {
  return t(ROLE_KEYS[role]);
}

/** Admin-only (the API refuses everyone else); shown to admins on the list. */
function CreateOrgForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const t = useT();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [joinPolicy, setJoinPolicy] = useState<'open' | 'request' | 'invite'>('request');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    const { error: err } = await api.POST('/orgs', {
      body: { slug, name, joinPolicy, visibility },
    });
    if (err) {
      setError(err.detail ?? t('orgs.createError'));
      return;
    }
    setError(null);
    setSlug('');
    setName('');
    await onCreated();
  }

  return (
    <>
      <h2>{t('orgs.new')}</h2>
      <p>
        <label>
          {t('orgs.slug')}{' '}
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="hanoi-cs" />
        </label>{' '}
        <label>
          {t('common.name')} <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>{' '}
        <label>
          {t('orgs.joining')}{' '}
          <select value={joinPolicy} onChange={(e) => setJoinPolicy(e.target.value as typeof joinPolicy)}>
            <option value="open">{t('joinPolicy.open')}</option>
            <option value="request">{t('joinPolicy.request')}</option>
            <option value="invite">{t('joinPolicy.invite')}</option>
          </select>
        </label>{' '}
        <label>
          {t('common.visibility')}{' '}
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as typeof visibility)}>
            <option value="public">{t('visibility.public')}</option>
            <option value="private">{t('visibility.private')}</option>
          </select>
        </label>{' '}
        <button type="button" disabled={slug === '' || name === ''} onClick={() => void create()}>
          {t('common.create')}
        </button>
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

export function OrgsPage() {
  const t = useT();
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const query = useQuery({
    queryKey: ['orgs'],
    queryFn: async () => {
      const result = await api.GET('/orgs', {});
      if (result.error) throw apiError(result, t('orgs.loadError'));
      return result.data;
    },
  });

  return (
    <section className="panel">
      <h1>{t('orgs.title')}</h1>
      {query.isPending ? <p className="muted">{t('common.loading')}</p> : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {query.data && query.data.items.length === 0 ? (
        <p className="muted">{t('orgs.empty')}</p>
      ) : null}
      {query.data && query.data.items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('orgs.colOrg')}</th>
              <th>{t('orgs.colJoining')}</th>
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
                <td>{t(POLICY_SHORT[org.joinPolicy])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {me.data?.globalRole === 'admin' ? (
        <CreateOrgForm onCreated={() => client.invalidateQueries({ queryKey: ['orgs'] })} />
      ) : null}
    </section>
  );
}

/** The deciders' queue — rendered only for an owner or admin. */
function RequestsQueue({ slug, onDecided }: { slug: string; onDecided: () => Promise<void> }) {
  const t = useT();
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
      setError(err.detail ?? t('org.decideError'));
      return;
    }
    setError(null);
    await client.invalidateQueries({ queryKey: ['org-requests', slug] });
    await onDecided();
  }

  if (!requests.data || requests.data.length === 0) return null;
  return (
    <>
      <h2>{t('org.requests')}</h2>
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
                  {t('org.approve')}
                </button>{' '}
                <button type="button" onClick={() => void decide(req.id, false)}>
                  {t('org.reject')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * The contests this organization runs (D56).
 *
 * `GET /contests?org=` rather than a route of its own: the filter answers
 * exactly the contests this caller could already see, so the section shows a
 * visitor the school's public contests and a member its private ones,
 * without this component knowing either rule. Silent on error and absent when
 * empty — a school with no contests should not grow an empty table, and a
 * failed list must not take the roster down with it.
 */
function OrgContests({ slug }: { slug: string }) {
  const t = useT();
  const contests = useQuery({
    queryKey: ['org-contests', slug],
    queryFn: async () => {
      const { data } = await api.GET('/contests', { params: { query: { org: slug } } });
      return data?.items ?? [];
    },
  });
  if (!contests.data || contests.data.length === 0) return null;
  return (
    <>
      <h2>{t('org.contests')}</h2>
      <ul>
        {contests.data.map((contest) => (
          <li key={contest.key}>
            <Link to="/contests/$key" params={{ key: contest.key }}>
              {contest.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function OrgPage({ slug }: { slug: string }) {
  const t = useT();
  const client = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const me = useQuery(meQueryOptions);
  const org = useQuery({
    queryKey: ['org', slug],
    queryFn: async () => {
      const result = await api.GET('/orgs/{slug}', { params: { path: { slug } } });
      if (result.error) throw apiError(result, t('org.notFound'));
      return result.data;
    },
  });
  // Paged since D58: the roster is no longer downloadable whole, so this is
  // the same `useInfiniteQuery` + "load more" shape the problems and
  // submissions lists use.
  const members = useInfiniteQuery({
    queryKey: ['org-members', slug],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: { cursor?: string } = {};
      if (pageParam !== undefined) query.cursor = pageParam;
      const result = await api.GET('/orgs/{slug}/members', {
        params: { path: { slug }, query },
      });
      if (result.error) throw apiError(result, t('org.notFound'));
      return result.data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const memberRows: Member[] = members.data?.pages.flatMap((page) => page.items) ?? [];

  // Both queries: `myRole` now rides on the organization row (D58), so a
  // join, a leave or a role change that refreshed only the roster would
  // leave the buttons above it describing the viewer's previous standing.
  async function refresh(): Promise<void> {
    await client.invalidateQueries({ queryKey: ['org-members', slug] });
    await client.invalidateQueries({ queryKey: ['org', slug] });
  }

  async function join(): Promise<void> {
    const { data, error } = await api.POST('/orgs/{slug}/join', { params: { path: { slug } } });
    if (error) {
      setActionError(error.detail ?? t('org.joinError'));
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
      setActionError(error.detail ?? t('org.removeError'));
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
      setActionError(error.detail ?? t('org.roleError'));
      return;
    }
    setActionError(null);
    await refresh();
  }

  if (org.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (org.error) return <p role="alert">{org.error.message}</p>;
  if (!org.data) return null;

  const myName = me.data?.username ?? null;
  // The viewer's own standing comes from the organization row (D58), NOT from
  // searching the roster: the roster is a page now, and a member sorted past
  // it would otherwise read as an outsider and be offered "Join".
  const myRole = org.data.myRole;
  const decider = myRole === 'owner' || myRole === 'admin';

  return (
    <section className="panel">
      <h1>{org.data.name}</h1>
      <p className="muted">
        {org.data.slug} · {t(POLICY_LONG[org.data.joinPolicy])}
      </p>
      {org.data.about ? <p>{org.data.about}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      {myName !== null && myRole === null && !requested && org.data.joinPolicy !== 'invite' ? (
        <p>
          <button type="button" onClick={() => void join()}>
            {org.data.joinPolicy === 'open' ? t('org.join') : t('org.requestToJoin')}
          </button>
        </p>
      ) : null}
      {requested ? <p>{t('org.requestSent')}</p> : null}

      {decider ? <RequestsQueue slug={slug} onDecided={refresh} /> : null}

      <OrgContests slug={slug} />

      <h2>{t('org.members')}</h2>
      {memberRows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('org.colMember')}</th>
              <th>{t('common.role')}</th>
              {decider || myRole !== null ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {memberRows.map((member) => (
              <tr key={member.username}>
                <td>
                  <Link to="/users/$username" params={{ username: member.username }}>
                    {member.username}
                  </Link>
                </td>
                <td>
                  {decider && member.username !== myName ? (
                    <select
                      aria-label={t('org.roleOf', { name: member.username })}
                      value={member.role}
                      onChange={(e) => void setRole(member.username, e.target.value as Member['role'])}
                    >
                      <option value="owner">{t('role.owner')}</option>
                      <option value="admin">{t('role.admin')}</option>
                      <option value="member">{t('role.member')}</option>
                    </select>
                  ) : (
                    roleLabel(t, member.role)
                  )}
                </td>
                {decider || myRole !== null ? (
                  <td>
                    {member.username === myName ? (
                      <button type="button" onClick={() => void leave(member.username)}>
                        {t('org.leave')}
                      </button>
                    ) : decider ? (
                      <button type="button" onClick={() => void leave(member.username)}>
                        {t('org.remove')}
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{t('org.noMembers')}</p>
      )}
      {members.hasNextPage ? (
        <p>
          <button
            type="button"
            onClick={() => void members.fetchNextPage()}
            disabled={members.isFetchingNextPage}
          >
            {t('common.loadMore')}
          </button>
        </p>
      ) : null}
    </section>
  );
}

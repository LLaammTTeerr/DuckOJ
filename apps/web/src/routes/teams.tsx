/**
 * Teams — "đội tuyển", the roster a team contest is entered by (D99).
 *
 * One panel, on the organization's page, modelled on `OrgSets` and for its
 * reasons: an owner or admin gets the assemble/edit/disband controls, a
 * member sees the teams they are ON (the server scopes the list, not this
 * file), and somebody in the school who is on none sees nothing at all
 * rather than an empty heading.
 *
 * There is deliberately no team DETAIL route. A team is a name and three
 * usernames; the panel already prints both, and every member is a link to
 * their profile — which is what "every entity is a hyperlink" is asking for
 * here. A page whose whole content is one row of this table would be a URL
 * with nothing on it.
 *
 * Nothing here renders for an anonymous visitor: every `/orgs/{slug}/teams`
 * route needs a session, so a query fired without one could only 401.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';
import { useT } from '../i18n/index.js';

type TeamSummary =
  paths['/orgs/{slug}/teams']['get']['responses'][200]['content']['application/json']['items'][number];
type TeamDetail =
  paths['/orgs/{slug}/teams/{teamSlug}']['get']['responses'][200]['content']['application/json'];

export function teamsKey(slug: string): [string, string] {
  return ['org-teams', slug];
}

/**
 * The usernames a teacher typed, as the API wants them.
 *
 * Commas, spaces and newlines all separate: a roster is pasted out of a
 * spreadsheet as often as it is typed, and refusing one of the three
 * separators would make the field a puzzle rather than a form.
 */
export function parseMembers(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export function OrgTeams({ slug, canManage }: { slug: string; canManage: boolean }) {
  const t = useT();
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Silent on failure, exactly as `OrgSets` and `OrgContests` are: this
  // section sits on somebody else's page, and a failed list must not take
  // that page down or stack a second alert onto it.
  const teams = useQuery({
    queryKey: teamsKey(slug),
    enabled: me.data != null,
    queryFn: async () => {
      const { data } = await api.GET('/orgs/{slug}/teams', { params: { path: { slug } } });
      return data?.items ?? [];
    },
  });

  async function refresh(): Promise<void> {
    setCreating(false);
    setEditing(null);
    await client.invalidateQueries({ queryKey: teamsKey(slug) });
  }

  async function disband(teamSlug: string): Promise<void> {
    const { error } = await api.DELETE('/orgs/{slug}/teams/{teamSlug}', {
      params: { path: { slug, teamSlug } },
    });
    if (error) {
      // The server's own wording: a team that has competed is refused with a
      // sentence explaining why, and paraphrasing it here would lose the
      // reason.
      setActionError(error.detail ?? t('teams.deleteError'));
      return;
    }
    setActionError(null);
    await refresh();
  }

  if (!me.data) return null;
  if (!canManage && (teams.data === undefined || teams.data.length === 0)) return null;

  return (
    <>
      <h2>{t('teams.title')}</h2>
      {actionError ? <p role="alert">{actionError}</p> : null}
      {teams.data && teams.data.length === 0 ? <p className="muted">{t('teams.empty')}</p> : null}
      {teams.data && teams.data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('teams.colTeam')}</th>
              <th>{t('teams.colMembers')}</th>
              {canManage ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {teams.data.map((team: TeamSummary) => (
              <tr key={team.slug}>
                <td>
                  {team.name} <span className="muted">{team.slug}</span>
                </td>
                <td>
                  <TeamMembers slug={slug} teamSlug={team.slug} count={team.memberCount} />
                </td>
                {canManage ? (
                  <td>
                    <button type="button" onClick={() => setEditing(team.slug)}>
                      {t('teams.edit')}
                    </button>{' '}
                    <button type="button" onClick={() => void disband(team.slug)}>
                      {t('teams.delete')}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canManage && editing !== null ? (
        <TeamForm slug={slug} teamSlug={editing} onSaved={refresh} onCancel={() => setEditing(null)} />
      ) : null}
      {canManage && editing === null && !creating ? (
        <p>
          <button type="button" onClick={() => setCreating(true)}>
            {t('teams.new')}
          </button>
        </p>
      ) : null}
      {canManage && creating ? (
        <TeamForm slug={slug} onSaved={refresh} onCancel={() => setCreating(false)} />
      ) : null}
    </>
  );
}

/**
 * A team's people, as links.
 *
 * Its own query per row rather than a `members` array on the summary: the
 * list endpoint serves a COUNT, and widening it to carry every roster would
 * make a page of twenty teams a page of sixty usernames nobody asked for.
 * The detail is only fetched for teams already on screen, and the panel
 * prints the count while it loads so the row never jumps.
 */
function TeamMembers({ slug, teamSlug, count }: { slug: string; teamSlug: string; count: number }) {
  const t = useT();
  const detail = useQuery({
    queryKey: ['org-team', slug, teamSlug],
    queryFn: async () => {
      const { data } = await api.GET('/orgs/{slug}/teams/{teamSlug}', {
        params: { path: { slug, teamSlug } },
      });
      return data ?? null;
    },
  });
  if (!detail.data) return <span className="muted">{t('teams.memberCount', { n: count })}</span>;
  return (
    <>
      {detail.data.members.map((member, index) => (
        <span key={member.username}>
          {index > 0 ? ', ' : ''}
          <Link to="/users/$username" params={{ username: member.username }}>
            {member.username}
          </Link>
        </span>
      ))}
      {detail.data.members.length === 0 ? <span className="muted">{t('teams.noMembers')}</span> : null}
    </>
  );
}

/** Assemble or edit. `members` replaces the whole roster, as the API says. */
function TeamForm({
  slug,
  teamSlug,
  onSaved,
  onCancel,
}: {
  slug: string;
  teamSlug?: string;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const existing = useQuery({
    queryKey: ['org-team', slug, teamSlug ?? ''],
    enabled: teamSlug !== undefined,
    queryFn: async (): Promise<TeamDetail | null> => {
      const { data } = await api.GET('/orgs/{slug}/teams/{teamSlug}', {
        params: { path: { slug, teamSlug: teamSlug! } },
      });
      return data ?? null;
    },
  });
  const loaded = existing.data ?? null;
  const [nextSlug, setNextSlug] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [members, setMembers] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The stored value until the reader types, so the form can be rendered
  // before the detail lands without clobbering what they typed afterwards.
  const slugValue = nextSlug ?? loaded?.slug ?? '';
  const nameValue = name ?? loaded?.name ?? '';
  const membersValue =
    members ?? (loaded ? loaded.members.map((member) => member.username).join(', ') : '');

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const body = { name: nameValue, members: parseMembers(membersValue) };
      const result = teamSlug
        ? await api.PATCH('/orgs/{slug}/teams/{teamSlug}', {
            params: { path: { slug, teamSlug } },
            body: { ...body, slug: slugValue },
          })
        : await api.POST('/orgs/{slug}/teams', {
            params: { path: { slug } },
            body: { ...body, slug: slugValue },
          });
      if (result.error) {
        setError(result.error.detail ?? t('teams.saveError'));
        return;
      }
      setError(null);
      await onSaved();
    } catch {
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>{teamSlug ? t('teams.edit') : t('teams.new')}</h3>
      <p>
        <label>
          {t('teams.slug')}{' '}
          <input value={slugValue} onChange={(e) => setNextSlug(e.target.value)} placeholder="doi-1" />
        </label>
        <label>
          {t('teams.name')} <input value={nameValue} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t('teams.members')}{' '}
          <textarea rows={2} value={membersValue} onChange={(e) => setMembers(e.target.value)} />
        </label>
      </p>
      <p className="muted">{t('teams.membersHint')}</p>
      {error ? <p role="alert">{error}</p> : null}
      <p>
        <button type="button" onClick={() => void save()} disabled={busy}>
          {t('teams.save')}
        </button>{' '}
        <button type="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </p>
    </>
  );
}

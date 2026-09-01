/**
 * Teams — "đội tuyển", the roster a team contest is entered by (D99).
 *
 * One panel, on the organization's page, modelled on `OrgSets` and for its
 * reasons: an owner or admin gets the assemble/edit/disband controls, a
 * member sees the teams they are ON (the server scopes the list, not this
 * file), and somebody in the school who is on none sees nothing at all
 * rather than an empty heading.
 *
 * `TeamPage` is the team's own URL, `/orgs/{slug}/teams/{teamSlug}`. F-24
 * argued a team was "a name and three usernames" and needed no page; what
 * changed is that a team now has a RECORD — the contests it entered, whether
 * one is running, who held each entry — and a record is a thing you link to.
 * The panel's team name is that link, which is what "every entity is a
 * hyperlink" was asking for all along.
 *
 * Nothing here renders for an anonymous visitor: every `/orgs/{slug}/teams`
 * route needs a session, so a query fired without one could only 401.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { read } from '../api-error.js';
import { meQueryOptions } from '../me.js';
import { formatDateTime, useLocale, useT } from '../i18n/index.js';

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

  // NOT silent on failure any more. This section sits on somebody else's
  // page, so a failure must not take that page down — but `?? []` did not
  // merely stay quiet, it answered the question: a 500 rendered
  // `teams.empty`, telling a teacher their school has no teams on the
  // morning they are looking for one. `read` throws instead, and the failure
  // is reported in this section alone (B-4's rule, B-8's `read`).
  const teams = useQuery({
    queryKey: teamsKey(slug),
    enabled: me.data != null,
    queryFn: async () => {
      const result = await api.GET('/orgs/{slug}/teams', { params: { path: { slug } } });
      return read(result, t('teams.listError'))?.items ?? [];
    },
  });

  async function refresh(): Promise<void> {
    setCreating(false);
    setEditing(null);
    // BOTH keys. The summary list carries a member COUNT; the names on each
    // row — and the edit form's prefill — come from `TeamMembers`' own query
    // under `['org-team', slug, teamSlug]`, and an invalidation matches by
    // key PREFIX, so `['org-teams', slug]` never touched it. A teacher who
    // added a pupil saw the count move to 2 and the names stay at one; worse,
    // re-opening the form prefilled from that stale roster, and `members`
    // REPLACES the whole roster — so the next save wrote the pre-edit list
    // back and dropped the pupil who had just been added.
    await client.invalidateQueries({ queryKey: teamsKey(slug) });
    await client.invalidateQueries({ queryKey: ['org-team', slug] });
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
  // A reader who manages nothing and is on no team sees nothing at all — but
  // a failed read is not "no teams", so the error still gets a heading and a
  // sentence rather than a silently absent section.
  if (!canManage && !teams.isError && (teams.data === undefined || teams.data.length === 0)) {
    return null;
  }

  // The warning, not a disabled button: the refusal belongs to the server
  // (409 `team_locked_during_contest`), and a client that greyed the control
  // out would be a second copy of the rule — one that goes wrong the moment
  // the exemption changes. What the banner buys is that a teacher learns the
  // rule BEFORE they open a form and lose what they typed to it.
  const competing = (teams.data ?? []).filter((team: TeamSummary) => team.inRunningContest);

  return (
    <>
      <h2>{t('teams.title')}</h2>
      {competing.length > 0 ? (
        <p role="status">
          {t('teams.lockedBanner', { names: competing.map((team) => team.name).join(', ') })}
        </p>
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {teams.isError ? <p role="alert">{t('teams.listError')}</p> : null}
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
                  <Link
                    to="/orgs/$slug/teams/$teamSlug"
                    params={{ slug, teamSlug: team.slug }}
                  >
                    {team.name}
                  </Link>{' '}
                  <span className="muted">{team.slug}</span>
                  {team.inRunningContest ? (
                    <>
                      {' '}
                      <span className="muted">{t('teams.competingNow')}</span>
                    </>
                  ) : null}
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
      const result = await api.GET('/orgs/{slug}/teams/{teamSlug}', {
        params: { path: { slug, teamSlug } },
      });
      return read(result, t('teams.membersError'));
    },
  });
  // The COUNT is real either way — it arrived with the summary row — so it
  // stays. What `?? null` cost was the difference between "still loading"
  // and "asked, and never answered", which are the same picture and
  // different facts.
  if (detail.isError) {
    return (
      <span className="muted">
        {t('teams.memberCount', { n: count })} · {t('teams.membersError')}
      </span>
    );
  }
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
      const result = await api.GET('/orgs/{slug}/teams/{teamSlug}', {
        params: { path: { slug, teamSlug: teamSlug! } },
      });
      return read(result, t('teams.loadError'));
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

  // An edit form over a roster that never loaded is the dangerous one:
  // `members` REPLACES the whole roster, so the empty box the reader is
  // shown is a saved change, and the save that looks like a no-op is the one
  // that empties the team. So the form is not rendered at all.
  if (teamSlug !== undefined && existing.isError) {
    return (
      <>
        <h3>{t('teams.edit')}</h3>
        <p role="alert">{t('teams.loadError')}</p>
        <p>
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        </p>
      </>
    );
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

/**
 * One team's own page — `/orgs/{slug}/teams/{teamSlug}`.
 *
 * Three things, in the order a reader wants them: who is on it, what it has
 * entered, and — when a round is running right now — why its roster cannot be
 * edited. The roster edit itself stays on the organization's page beside the
 * other teams, because editing one team is a thing you do while looking at
 * all of them.
 *
 * 404 is the answer for a team that does not exist, one in a school the
 * viewer may not see, and one they neither run nor belong to — the server
 * makes those indistinguishable on purpose (`team_not_found`), so this page
 * prints one sentence for all three rather than guessing which it was.
 */
export function TeamPage({ slug, teamSlug }: { slug: string; teamSlug: string }) {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const me = useQuery(meQueryOptions);
  const team = useQuery({
    queryKey: ['org-team', slug, teamSlug],
    enabled: me.data != null,
    queryFn: async (): Promise<TeamDetail | null> => {
      const result = await api.GET('/orgs/{slug}/teams/{teamSlug}', {
        params: { path: { slug, teamSlug } },
      });
      // 404 is an ANSWER here and the sentence below is the right one for
      // it; every other status is the question going unanswered, and saying
      // "no such team" to a 500 tells a captain their team was disbanded.
      return read(result, t('teams.loadError'), [404]);
    },
  });

  if (me.data == null) return <p role="alert">{t('teams.signInFirst')}</p>;
  if (team.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (team.isError) return <p role="alert">{t('teams.loadError')}</p>;
  if (!team.data) return <p role="alert">{t('teams.notFound')}</p>;

  const detail = team.data;
  return (
    <section>
      <h1>{detail.name}</h1>
      <p className="muted">
        <Link to="/orgs/$slug" params={{ slug: detail.orgSlug }}>
          {detail.orgName}
        </Link>{' '}
        · {detail.slug}
      </p>
      {detail.inRunningContest ? <p role="status">{t('teams.lockedNow')}</p> : null}

      <h2>{t('teams.colMembers')}</h2>
      {detail.members.length === 0 ? (
        <p className="muted">{t('teams.noMembers')}</p>
      ) : (
        <ul>
          {detail.members.map((member) => (
            <li key={member.username}>
              <Link to="/users/$username" params={{ username: member.username }}>
                {member.username}
              </Link>{' '}
              <span className="muted">{member.displayName}</span>
            </li>
          ))}
        </ul>
      )}

      <h2>{t('teams.contests')}</h2>
      {detail.contests.length === 0 ? (
        <p className="muted">{t('teams.noContests')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('teams.colContest')}</th>
              <th>{t('teams.colWhen')}</th>
              <th>{t('teams.colEntry')}</th>
              <th>{t('teams.colResults')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.contests.map((entry) => (
              <tr key={entry.key}>
                <td>
                  <Link to="/contests/$key" params={{ key: entry.key }}>
                    {entry.name}
                  </Link>
                </td>
                {/* The reader's own zone (D57), like every other screen —
                    a raw `toLocaleString()` here would print the browser's. */}
                <td>{formatDateTime(entry.startTime, locale, timeZone)}</td>
                <td>
                  {/* The captain is the account that holds the row (D99) —
                      the one the disqualify control is keyed by, so it is
                      the one worth naming. */}
                  <Link to="/users/$username" params={{ username: entry.captain }}>
                    {entry.captain}
                  </Link>
                  {entry.running ? ` · ${t('teams.running')}` : ''}
                  {entry.isDisqualified ? ` · ${t('teams.disqualified')}` : ''}
                </td>
                <td>
                  {/* The contest's own scoreboard, not a rank computed here:
                      a standing belongs to the board that folds it, and it
                      means nothing yet for a round still running. */}
                  <Link to="/contests/$key/scoreboard" params={{ key: entry.key }}>
                    {t('teams.scoreboard')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

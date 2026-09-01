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
import {
  ORG_IMPORT_MAX_ROWS,
  credentialsCsv,
  importIdentities,
  splitImportCsv,
} from '@duckoj/contracts';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError, read } from '../api-error.js';
import { meQueryOptions } from '../me.js';
import { LoadError } from '../states.js';
import { useT, type MsgKey, type TFunction } from '../i18n/index.js';
import { ErrorSummary, FieldError, fieldProps } from '../forms.js';
import { OrgSets } from './problem-sets.js';
import { OrgTeams } from './teams.js';

type Org = paths['/orgs']['get']['responses'][200]['content']['application/json']['items'][number];
type Member =
  paths['/orgs/{slug}/members']['get']['responses'][200]['content']['application/json']['items'][number];
type JoinRequest =
  paths['/orgs/{slug}/requests']['get']['responses'][200]['content']['application/json']['items'][number];

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

/** The create form's two required inputs, in screen order (D110/D146). */
const FIELD_ORDER = ['slug', 'org-name'] as const;

/** Admin-only (the API refuses everyone else); shown to admins on the list. */
function CreateOrgForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const t = useT();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [joinPolicy, setJoinPolicy] = useState<'open' | 'request' | 'invite'>('request');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [error, setError] = useState<string | null>(null);
  /**
   * This form had NO busy flag at all (D148), and no `try/catch` either — the
   * one async handler on this site that was neither. So a double click sent
   * two `POST /orgs` (the second answered `org_slug_taken`, which reads as
   * "somebody else took the name you just chose"), and a dead network was an
   * unhandled rejection with nothing on screen at all.
   */
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<'slug' | 'org-name', string>>>({});
  const [attempt, setAttempt] = useState(0);

  async function create(): Promise<void> {
    if (busy) return;
    setAttempt((n) => n + 1);
    const invalid: Partial<Record<'slug' | 'org-name', string>> = {};
    if (slug.trim() === '') invalid.slug = t('form.required');
    if (name.trim() === '') invalid['org-name'] = t('form.required');
    setFieldErrors(invalid);
    if (Object.keys(invalid).length > 0) return;

    setBusy(true);
    setError(null);
    try {
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
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setError(t('common.networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>{t('orgs.new')}</h2>
      {/* D110's Focusable Error Summary, reused rather than reinvented. */}
      <ErrorSummary errors={fieldErrors} order={FIELD_ORDER} attempt={attempt} />
      <p>
        <label>
          {t('orgs.slug')}{' '}
          <input
            {...fieldProps('slug', fieldErrors.slug)}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="hanoi-cs"
          />
        </label>
        <FieldError id="slug" message={fieldErrors.slug} />{' '}
        <label>
          {t('common.name')}{' '}
          <input
            {...fieldProps('org-name', fieldErrors['org-name'])}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <FieldError id="org-name" message={fieldErrors['org-name']} />{' '}
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
        {/* D148 — live unless it is genuinely busy, and it says the verb
            while it is. */}
        <button type="button" disabled={busy} aria-busy={busy} onClick={() => void create()}>
          {busy ? t('form.creating') : t('common.create')}
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
  /**
   * **Paged since D180.** A plain `useQuery` read `.items` and dropped
   * `nextCursor`, so the server's page of twenty-five was a ceiling: with 28
   * schools on the live judge today, **three were already unreachable** from
   * this page — the front door to every one of them.
   *
   * The order is KEPT at `asc(id)`. A reader looking for their own school
   * wants it by NAME, and that is a real gap — but it is an API change (a
   * second cursor grammar over `organizations.slug`) plus the search box F-49
   * argued for the roster, and both are named as follow-ups rather than
   * smuggled in behind a load-more button. At 28 schools, reachable is the
   * whole of the defect.
   */
  const query = useInfiniteQuery({
    queryKey: ['orgs', 'list'],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const search: { cursor?: string } = {};
      if (pageParam !== undefined) search.cursor = pageParam;
      const result = await api.GET('/orgs', { params: { query: search } });
      if (result.error) throw apiError(result, t('orgs.loadError'));
      return result.data;
    },
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
  });
  const rows: Org[] | undefined = query.data
    ? query.data.pages.flatMap((page) => page?.items ?? [])
    : undefined;

  return (
    <section className="panel">
      <h1>{t('orgs.title')}</h1>
      {query.isPending ? <p className="muted">{t('common.loading')}</p> : null}
      {query.error ? (
        <LoadError
          error={query.error}
          what={t('orgs.loadError')}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {rows && rows.length === 0 ? <p className="muted">{t('orgs.empty')}</p> : null}
      {rows && rows.length > 0 ? (
        <div className="table-wrap" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>{t('orgs.colOrg')}</th>
              <th>{t('orgs.colJoining')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((org: Org) => (
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
        </div>
      ) : null}
      {query.hasNextPage ? (
        <p>
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {t('common.loadMore')}
          </button>
        </p>
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
  // **A page since D181.** This endpoint had no bound at all — no limit, no
  // cursor — and this panel rendered every row it answered into one table: a
  // school that opens enrolment to a province put five thousand `<tr>` on the
  // page a teacher opens to approve three people. The queue is now walked
  // twenty-five at a time, oldest first, which is the order a queue is
  // answered in and is unchanged.
  const requests = useInfiniteQuery({
    queryKey: ['org-requests', slug],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      // This queue is rendered only for an owner or an admin, so there is no
      // status here that means "nothing to decide" — an empty queue is a 200
      // with an empty page. A swallowed failure read as exactly that, and a
      // decider watching an empty screen has no reason to look again.
      const query: { cursor?: string } = {};
      if (pageParam !== undefined) query.cursor = pageParam;
      return read(
        await api.GET('/orgs/{slug}/requests', { params: { path: { slug }, query } }),
        t('org.requestsLoadError'),
      );
    },
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
  });
  const rows: JoinRequest[] | undefined = requests.data
    ? requests.data.pages.flatMap((page) => page?.items ?? [])
    : undefined;

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

  // A failed queue and an empty queue are the same absence to a decider
  // watching this space, and the empty one is the reassuring reading. Say
  // which it is.
  if (requests.isError) return <p role="alert">{t('org.requestsLoadError')}</p>;
  if (!rows || rows.length === 0) return null;
  return (
    <>
      <h2>{t('org.requests')}</h2>
      {error ? <p role="alert">{error}</p> : null}
      <table>
        <tbody>
          {rows.map((req) => (
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
      {requests.hasNextPage ? (
        <p>
          <button
            type="button"
            onClick={() => void requests.fetchNextPage()}
            disabled={requests.isFetchingNextPage}
          >
            {t('common.loadMore')}
          </button>
        </p>
      ) : null}
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
  // **Paged since D180.** It read `.items` and dropped `nextCursor`, so a
  // school's twenty-sixth round was invisible on the school's own page — with
  // 167 rounds on the live judge, that is not a hypothetical shape. The `org`
  // filter rides along on every page: page two of "every contest on the
  // judge" is not page two of "this school's contests".
  //
  // `asc(id)` is kept. This section is a school's noticeboard, read top to
  // bottom, and nothing here is tailed the way a teacher tails the team list.
  const contests = useInfiniteQuery({
    queryKey: ['org-contests', slug],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const query: { org: string; cursor?: string } = { org: slug };
      if (pageParam !== undefined) query.cursor = pageParam;
      return read(await api.GET('/contests', { params: { query } }), t('contests.loadError'));
    },
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
  });
  const rows = contests.data ? contests.data.pages.flatMap((page) => page?.items ?? []) : undefined;
  // The section still cannot take the roster down with it — that part of the
  // doc comment above stands — but "absent because the school runs none" and
  // "absent because the request failed" are now different renders. They were
  // the same one, which is the shape B-8 called out: a rival school's page
  // reading as "no contests" the moment the list 500s.
  if (contests.isError) return <p role="alert">{t('contests.loadError')}</p>;
  if (!rows || rows.length === 0) return null;
  return (
    <>
      <h2>{t('org.contests')}</h2>
      <ul>
        {rows.map((contest) => (
          <li key={contest.key}>
            <Link to="/contests/$key" params={{ key: contest.key }}>
              {contest.name}
            </Link>
          </li>
        ))}
      </ul>
      {contests.hasNextPage ? (
        <p>
          <button
            type="button"
            onClick={() => void contests.fetchNextPage()}
            disabled={contests.isFetchingNextPage}
          >
            {t('common.loadMore')}
          </button>
        </p>
      ) : null}
    </>
  );
}

/**
 * "Nhập danh sách học sinh" — D61's roster import, for an owner.
 *
 * Two steps, deliberately: **check** (`dryRun`) shows the school exactly what
 * the server understood before anything is created, and **confirm** creates
 * it. The passwords come back once and are recoverable from nowhere, so the
 * result is rendered three ways at once — a table styled for a printer, a
 * download, and a plain-text box — because each of the three fails somewhere.
 * A download is inert in an embedded viewer; a print dialog is missing on a
 * tablet; a selection is the one that always works.
 */
function RosterImportPanel({ slug, onImported }: { slug: string; onImported: () => Promise<void> }) {
  const t = useT();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [rowErrors, setRowErrors] = useState<RowError[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  /** `[done, total]` chunks, for the progress bar; `null` when idle. */
  const [progress, setProgress] = useState<[number, number] | null>(null);

  /**
   * One roster, several requests (D61 amended).
   *
   * The server caps a request at `ORG_IMPORT_MAX_ROWS` so it stays under a
   * few seconds of argon2id, which makes a province-sized class the client's
   * problem to cut up — and a teacher with a 3,000-row spreadsheet must not
   * be sent to a text editor. `splitImportCsv` is the SERVER's own record
   * grammar (`@duckoj/contracts`), so a quoted newline cannot become a chunk
   * boundary and every chunk carries the file's header.
   *
   * Sequential, never `Promise.all`: the meter is ten a minute and the
   * hashing is one shared thread pool, so parallel chunks would earn a 429
   * and a half-created roster for no wall-clock gain.
   */
  async function send(dryRun: boolean): Promise<void> {
    const chunks = splitImportCsv(csv, ORG_IMPORT_MAX_ROWS);
    if (chunks.length === 0) {
      setError(t('import.error'));
      return;
    }
    setBusy(true);
    setProgress([0, chunks.length]);
    const rows: PreviewRow[] = [];
    const created: ImportResult['created'] = [];
    try {
      for (const [index, chunk] of chunks.entries()) {
        const { data, error: err } = await api.POST('/orgs/{slug}/members/import', {
          params: { path: { slug } },
          body: { csv: chunk, dryRun },
        });
        if (err) {
          // Per-row failures ride in `fields`, keyed `rows[<n>].<field>` — the
          // one structured slot `ProblemDetails` has. The row numbers are
          // per-REQUEST, so they are shifted back onto the teacher's file;
          // anything else (403, 429, a 422 about the body itself) is one
          // sentence.
          const sentence = err.detail ?? t('import.error');
          setPreview(null);
          // Whatever the earlier chunks created exists, with passwords that
          // exist nowhere else — showing the file's failure and throwing them
          // away is how a class ends up locked out of accounts it owns. The
          // credentials view takes the screen, so the reason has to travel
          // into it.
          if (created.length > 0) {
            setRowErrors(null);
            setError(`${t('import.stopped', { done: index, total: chunks.length })} ${sentence}`);
            setResult({ created, csv: credentialsCsv(created) });
            await onImported();
            return;
          }
          const failures = toRowErrors(err.fields, index * ORG_IMPORT_MAX_ROWS);
          setRowErrors(failures.length > 0 ? failures : null);
          setError(failures.length > 0 ? null : sentence);
          return;
        }
        if (dryRun) {
          rows.push(...(data as { rows: PreviewRow[] }).rows);
        } else {
          created.push(...(data as ImportResult).created);
        }
        setProgress([index + 1, chunks.length]);
      }
      setError(null);
      setRowErrors(null);
      if (dryRun) {
        setPreview(rows);
      } else {
        setPreview(null);
        // Built once from the merged rows rather than by concatenating each
        // request's own file: every response is a WHOLE sheet, header and
        // BOM included, so joining them put a second header row (and a
        // second byte-order mark) in the middle of the teacher's download,
        // where Excel reads it as a pupil called `username`.
        setResult({ created, csv: credentialsCsv(created) });
        await onImported();
      }
    } catch {
      setError(t('import.error'));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /**
   * The one rule no single request can check: an identity the file repeats in
   * two different chunks.
   *
   * A PREVIEW creates nothing, so the server has nothing to compare chunk two
   * against and every chunk previews clean. The real import then refuses chunk
   * two — correctly, and after chunk one has already created accounts, which
   * leaves the teacher holding half a class and a printout to match. This
   * function is the only thing that sees the whole file before any of it is
   * sent.
   *
   * **Both identity columns**, case-folded the way `users_username_lower_idx`
   * and `users_email_lower_idx` fold them. It used to scan usernames alone,
   * which B11 recorded as "one field short": an address is uniquely indexed
   * exactly as a username is, and a repeated one strands a sequence exactly
   * the same way. A blank address is skipped — the server invents a
   * placeholder from the username for those (D61), and a placeholder can only
   * collide when the username already has.
   */
  function crossChunkDuplicate(): { field: 'username' | 'email'; value: string } | null {
    const seenUsernames = new Set<string>();
    const seenEmails = new Set<string>();
    for (const { username, email } of importIdentities(csv)) {
      const usernameKey = username.toLowerCase();
      if (usernameKey !== '') {
        if (seenUsernames.has(usernameKey)) return { field: 'username', value: username };
        seenUsernames.add(usernameKey);
      }
      const emailKey = email.toLowerCase();
      if (emailKey !== '') {
        if (seenEmails.has(emailKey)) return { field: 'email', value: email };
        seenEmails.add(emailKey);
      }
    }
    return null;
  }

  async function check(): Promise<void> {
    const duplicate = crossChunkDuplicate();
    if (duplicate !== null) {
      setPreview(null);
      setRowErrors(null);
      setError(
        duplicate.field === 'username'
          ? t('import.duplicate', { username: duplicate.value })
          : t('import.duplicateEmail', { email: duplicate.value }),
      );
      return;
    }
    await send(true);
  }

  async function readFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setCsv(await file.text());
    setPreview(null);
    setRowErrors(null);
  }

  if (result) {
    return (
      <>
        <h2>{t('import.credentials')}</h2>
        <p role="alert">{t('import.credentialsWarning')}</p>
        {/* A part of the file failed after earlier parts had created
            accounts: these passwords are real and the rest of the roster is
            not imported. */}
        {error ? <p role="alert">{error}</p> : null}
        <p className="no-print">
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(result.csv)}`}
            download={`${slug}-accounts.csv`}
          >
            {t('import.download')}
          </a>{' '}
          <button type="button" onClick={() => window.print()}>
            {t('import.print')}
          </button>
        </p>
        <table className="print-credentials">
          <thead>
            <tr>
              <th>{t('import.colUsername')}</th>
              <th>{t('import.colName')}</th>
              <th>{t('import.colPassword')}</th>
            </tr>
          </thead>
          <tbody>
            {result.created.map((row) => (
              <tr key={row.username}>
                <td>{row.username}</td>
                <td>{row.displayName}</td>
                <td>{row.password}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* The always-works copy. A blob or `data:` download is inert inside
            some embedded browsers, and a selection is not.

            Without the BOM: it is there so Excel reads the FILE as UTF-8,
            and this is not the file — it is text somebody selects and pastes
            into whatever they already have open, where a leading U+FEFF is
            an invisible character in the middle of their document. */}
        <p className="no-print">{t('import.copyHint')}</p>
        <textarea
          className="no-print"
          readOnly
          rows={8}
          value={result.csv.replace(/^\ufeff/, '')}
          aria-label={t('import.copyLabel')}
        />
      </>
    );
  }

  return (
    <>
      <h2>{t('import.title')}</h2>
      <p className="muted">{t('import.hint')}</p>
      <p>
        {/* The app's own control, not the browser's: a bare file input is
            painted by the OS ("Choose File | No file chosen", in English, in
            the light chrome even on a dark page) and no token reaches it.
            `.file-pick` makes the LABEL the button and leaves the input
            focusable behind it — the same picker the submit editor uses. */}
        <label className="file-pick">
          <span>{t('import.file')}</span>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label={t('import.file')}
            onChange={(e) => void readFile(e.target.files?.[0])}
          />
        </label>
      </p>
      <p>
        <textarea
          rows={8}
          value={csv}
          aria-label={t('import.csv')}
          placeholder={'hs001,Nguyễn Văn A\nhs002,Trần Thị B'}
          onChange={(e) => {
            setCsv(e.target.value);
            setPreview(null);
            setRowErrors(null);
          }}
        />
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {rowErrors ? (
        <table>
          <thead>
            <tr>
              <th>{t('import.colRow')}</th>
              <th>{t('import.colField')}</th>
              <th>{t('import.colProblem')}</th>
            </tr>
          </thead>
          <tbody>
            {rowErrors.map((row) => (
              <tr key={`${String(row.row)}-${row.field}-${row.message}`}>
                <td>{row.row === 0 ? '—' : row.row}</td>
                <td>{row.field}</td>
                <td>{row.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {preview ? (
        <>
          <p>{t('import.previewCount', { n: preview.length })}</p>
          <table>
            <thead>
              <tr>
                <th>{t('import.colUsername')}</th>
                <th>{t('import.colName')}</th>
                <th>{t('import.colEmail')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((row) => (
                <tr key={row.username}>
                  <td>{row.username}</td>
                  <td>{row.displayName}</td>
                  <td>{row.emailProvided ? row.email : <span className="muted">{t('import.noEmail')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {progress ? (
        <p>
          {/* A 3,000-pupil roster is six requests and half a minute; a button
              that just says "busy" for that long reads as a hung page. */}
          <progress value={progress[0]} max={progress[1]} />{' '}
          {t('import.progress', { done: progress[0], total: progress[1] })}
        </p>
      ) : null}
      <p>
        <button type="button" disabled={csv.trim() === '' || busy} onClick={() => void check()}>
          {t('import.check')}
        </button>{' '}
        <button type="button" disabled={preview === null || busy} onClick={() => void send(false)}>
          {t('import.confirm')}
        </button>
      </p>
    </>
  );
}

interface PreviewRow {
  username: string;
  displayName: string;
  email: string;
  emailProvided: boolean;
}
interface ImportResult {
  created: Array<{ username: string; displayName: string; password: string }>;
  csv: string;
}
interface RowError {
  row: number;
  field: string;
  message: string;
}

/**
 * `fields` back into rows. The key is `rows[<n>].<field>`; anything that does
 * not match that shape is not a row problem and is left to the sentence the
 * server sent, so a future validation key added elsewhere cannot render as a
 * row number of `NaN`.
 */
function toRowErrors(fields: Record<string, string[]> | undefined, offset = 0): RowError[] {
  const out: RowError[] = [];
  for (const [key, messages] of Object.entries(fields ?? {})) {
    const match = /^rows\[(\d+)\]\.(.+)$/.exec(key);
    if (!match) continue;
    // `rows[0]` is the file as a whole, not a row, so it keeps its 0 rather
    // than being shifted into the middle of somebody else's chunk.
    const row = Number(match[1]);
    for (const message of messages) {
      out.push({ row: row === 0 ? 0 : row + offset, field: match[2]!, message });
    }
  }
  return out.sort((a, b) => a.row - b.row);
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
  //
  // D185: and searchable, because paging alone is not enough here. The
  // org-import contract already advertises a five-thousand-pupil roster, and
  // twenty-five rows a press is two hundred presses to reach one pupil. `q`
  // is a WORD of the username or the display name with Vietnamese diacritics
  // folded, so a teacher types `nguyen`, or `an`, and gets *Nguyễn Văn An*.
  const [memberQuery, setMemberQuery] = useState('');
  const members = useInfiniteQuery({
    // `memberQuery` is part of the KEY, never only part of the request. One
    // key for both would carry a search's cursor into the unfiltered walk's
    // seek and truncate it silently — D180's lesson from the contest filter,
    // and the reason the search restarts at page one when the box changes.
    queryKey: ['org-members', slug, memberQuery],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      // `exactOptionalPropertyTypes`: an absent key and an `undefined` one
      // are different requests, and an empty box must ask for the whole
      // roster rather than for `q=`.
      const query: { cursor?: string; q?: string } = {};
      if (pageParam !== undefined) query.cursor = pageParam;
      if (memberQuery.trim() !== '') query.q = memberQuery.trim();
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
  // D145: the fallback behind this message is `org.notFound`, so a 500 used
  // to tell a teacher their school is not on the system.
  if (org.error) return <LoadError error={org.error} onRetry={() => void org.refetch()} />;
  if (!org.data) return null;

  const myName = me.data?.username ?? null;
  // D191. `fetchMe` resolves to `null` for a signed-out visitor rather than
  // throwing, so `isSuccess && data === null` is "we know they are anonymous"
  // — as opposed to "we have not asked yet", which must not flash the
  // signed-out notice at a teacher who is about to be recognised.
  const signedOut = me.isSuccess && me.data === null;
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

      {/* Owner or global admin only — the API refuses an org `admin` (D61),
          and offering a control that always 403s is worse than not having
          one. */}
      {myRole === 'owner' || me.data?.globalRole === 'admin' ? (
        <RosterImportPanel slug={slug} onImported={refresh} />
      ) : null}

      {/* Between the import panel and the contests: homework is what a
          school's own members come to this page for, and it is invisible to
          anyone who is not one (D66). */}
      <OrgSets slug={slug} canManage={decider || me.data?.globalRole === 'admin'} />

      {/* Beside the homework, and for its reason: a school's teams are what
          its own members come here for before a team round, and they are
          invisible to anybody who is neither staff nor on one (D99). */}
      <OrgTeams slug={slug} canManage={decider || me.data?.globalRole === 'admin'} />

      <OrgContests slug={slug} />

      <h2>{t('org.members')}</h2>
      {/* D191. A signed-out visitor gets ONE page of a public school's roster
          and no search — the API refuses `cursor` and `q` from an anonymous
          caller, and never hands one a `nextCursor`. So the box is not
          rendered (a control that always 401s is worse than no control) and
          the cap is SAID, because D187's lesson is that a cap a reader cannot
          see is worse than the cap: without this line a five-thousand-pupil
          school reads as a school of twenty-five. */}
      {signedOut ? (
        <p className="muted">{t('org.rosterSignedOut')}</p>
      ) : (
        /* The same bare label+input the problems list uses (no new class, no
           debounce anywhere in this app), and no submit button: the query key
           IS the box, so there is nothing to press. */
        <div className="field">
          <label htmlFor="org-member-search">{t('org.searchMembers')}</label>
          <input
            id="org-member-search"
            value={memberQuery}
            placeholder={t('org.searchMembersHint')}
            onChange={(e) => setMemberQuery(e.target.value)}
          />
        </div>
      )}
      {memberRows.length > 0 ? (
        <div className="table-wrap" tabIndex={0}>
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
                  {/* D185. A roster minted by a bulk import (D61) is a column
                      of `hs000123`, and a search that matched a NAME has to
                      show the name it matched or it has answered nothing. */}
                  {member.displayName !== member.username ? (
                    <>
                      {' '}
                      <span className="muted">{member.displayName}</span>
                    </>
                  ) : null}
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
        </div>
      ) : members.isError ? null : (
        // Two different empty states, deliberately. "No visible members" said
        // to a teacher who has just mistyped a name is a lie about the school
        // rather than about the search.
        //
        // And neither of them is said when the read FAILED (D144): a query
        // that threw has no rows either, and printing "No visible members"
        // over a 429 or a 500 tells a reader a fact about the school that the
        // server never answered.
        <p className="muted">
          {memberQuery.trim() === ''
            ? t('org.noMembers')
            : t('org.noMemberMatch', { q: memberQuery.trim() })}
        </p>
      )}
      {/* D145/D191. This query had NO error state at all: `org.error` got a
          `LoadError` and a failing roster — including a `fetchNextPage` that
          the D191 walk meter refuses with 429 — vanished silently. It sits
          BELOW the table on purpose, because a refused "load more" keeps the
          pages already loaded and blanking them would punish the reader for
          the meter. */}
      {members.isError ? (
        <LoadError
          error={members.error}
          what={t('org.membersLoadError')}
          onRetry={() => void members.refetch()}
        />
      ) : null}
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

/**
 * Classroom problem sets — homework, "bài tập về nhà" (D66).
 *
 * Three screens and one panel:
 *   - `OrgSets` — the section on an organization's page. Every member sees
 *     the list with their own "done" count; an owner or admin also gets the
 *     assign form.
 *   - `ProblemSetPage` — the pupil's view of one set: the problems, their own
 *     best result on each, and a link that submits to it.
 *   - `ProblemSetProgressPage` — the teacher's grid, plus the CSV.
 *   - `SetForm` — assign or edit, with a problem picker that searches the
 *     existing `GET /problems` rather than a list endpoint of its own.
 *
 * Nothing here renders for an anonymous visitor: every route under
 * `/orgs/{slug}/sets` needs a session, so a query that fired without one
 * could only 401.
 */
import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { API_PREFIX } from '@duckoj/api-prefix';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { apiError, read } from '../api-error.js';
import { meQueryOptions } from '../me.js';
import { LoadError } from '../states.js';
import { renderStatement } from '../markdown.js';
import { formatDateTime, useLocale, useT, verdictName, type TFunction } from '../i18n/index.js';
import { verdictToken } from './submit.js';

type SetSummary =
  paths['/orgs/{slug}/sets']['get']['responses'][200]['content']['application/json']['items'][number];
type SetDetail =
  paths['/orgs/{slug}/sets/{setSlug}']['get']['responses'][200]['content']['application/json'];
type SetItem = SetDetail['items'][number];
type Attempt = NonNullable<NonNullable<SetItem['me']>['onTime']>;
type Progress =
  paths['/orgs/{slug}/sets/{setSlug}/progress']['get']['responses'][200]['content']['application/json'];

/** One problem as the picker holds it while the teacher builds a set. */
interface PickedProblem {
  code: string;
  name: string;
  points: number;
}

function setsKey(slug: string): [string, string] {
  return ['org-sets', slug];
}

/**
 * A verdict badge, the app's one visual language for a graded result
 * (`.badge` + the lowercase code, `submit.tsx`'s `verdictToken`). `—` when
 * there is nothing: a problem never attempted is not pending anything, so it
 * gets no badge at all — the same choice the problem list makes.
 */
function VerdictCell({ attempt, t }: { attempt: Attempt | null | undefined; t: TFunction }) {
  if (!attempt) return <span className="muted">—</span>;
  return (
    <>
      <span className={`badge ${verdictToken(attempt.verdict)}`} title={verdictName(t, attempt.verdict)}>
        {attempt.verdict}
      </span>
      {attempt.points !== null ? <small> {attempt.points}</small> : null}
    </>
  );
}

/**
 * The problem picker: a search box over `GET /problems`, the chosen problems
 * as an ordered list with their per-set points.
 *
 * The order is the teacher's, so it is theirs to change — hence the up/down
 * buttons rather than a drag handle, which is unusable from a keyboard and
 * from a phone alike.
 */
function ProblemPicker({
  picked,
  onChange,
}: {
  picked: PickedProblem[];
  onChange: (next: PickedProblem[]) => void;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['problem-picker', q],
    // Only searches, never the whole catalogue: an empty box is not a
    // request for every problem on the judge.
    enabled: q.trim() !== '',
    queryFn: async () => {
      const result = await api.GET('/problems', { params: { query: { q, limit: 10 } } });
      if (result.error) throw apiError(result, t('sets.loadError'));
      return result.data.items;
    },
  });

  function add(code: string, name: string): void {
    if (picked.some((p) => p.code === code)) return;
    onChange([...picked, { code, name, points: 100 }]);
  }

  function move(index: number, by: number): void {
    const next = [...picked];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <>
      <h3>{t('sets.problems')}</h3>
      {picked.length === 0 ? <p className="muted">{t('sets.pickerEmpty')}</p> : null}
      {picked.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('sets.colProblem')}</th>
              <th className="num">{t('sets.colPoints')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {picked.map((problem, index) => (
              <tr key={problem.code}>
                <td>
                  <code>{problem.code}</code> {problem.name}
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    aria-label={t('sets.pointsOf', { code: problem.code })}
                    value={problem.points}
                    onChange={(e) => {
                      const next = [...picked];
                      next[index] = { ...problem, points: Number(e.target.value) };
                      onChange(next);
                    }}
                  />
                </td>
                <td>
                  <button type="button" onClick={() => move(index, -1)}>
                    {t('sets.pickerUp')}
                  </button>{' '}
                  <button type="button" onClick={() => move(index, 1)}>
                    {t('sets.pickerDown')}
                  </button>{' '}
                  <button type="button" onClick={() => onChange(picked.filter((p) => p.code !== problem.code))}>
                    {t('sets.pickerRemove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p>
        <label>
          {t('sets.pickerSearch')}{' '}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="aplusb" />
        </label>
      </p>
      {q.trim() !== '' && results.data && results.data.length === 0 ? (
        <p className="muted">{t('sets.pickerNoResults')}</p>
      ) : null}
      {results.data && results.data.length > 0 ? (
        <ul>
          {results.data.map((problem) => (
            <li key={problem.code}>
              <code>{problem.code}</code> {problem.name}{' '}
              <button type="button" onClick={() => add(problem.code, problem.name)}>
                {t('sets.pickerAdd')}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * Assign a set, or edit one. `existing` decides which — the same form either
 * way, because the fields are the same and two of them would drift.
 *
 * `deadline` is a `datetime-local` value, which is LOCAL wall-clock time with
 * no zone: it goes to the API as a real instant via `new Date(...)`, and
 * comes back the same way, so what a teacher typed at 23:59 is 23:59 where
 * they are.
 */
function SetForm({
  slug,
  existing,
  onSaved,
  onCancel,
}: {
  slug: string;
  existing?: SetDetail;
  onSaved: () => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [setSlug, setSetSlug] = useState(existing?.slug ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [deadline, setDeadline] = useState(toLocalInput(existing?.deadline ?? null));
  const [picked, setPicked] = useState<PickedProblem[]>(
    existing?.items.map((item) => ({ code: item.code, name: item.name, points: item.points })) ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const body = {
        name,
        description: description === '' ? null : description,
        deadline: deadline === '' ? null : new Date(deadline).toISOString(),
        problems: picked.map((problem) => ({ code: problem.code, points: problem.points })),
      };
      const result = existing
        ? await api.PATCH('/orgs/{slug}/sets/{setSlug}', {
            params: { path: { slug, setSlug: existing.slug } },
            body: { ...body, slug: setSlug },
          })
        : await api.POST('/orgs/{slug}/sets', {
            params: { path: { slug } },
            body: { ...body, slug: setSlug },
          });
      if (result.error) {
        // The server's own wording, verbatim: a per-problem refusal names
        // the row in `fields`, and its `detail` is already a sentence.
        setError(result.error.detail ?? t('sets.saveError'));
        return;
      }
      setError(null);
      await onSaved();
    } catch {
      setError(t('sets.saveError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>{existing ? t('sets.edit') : t('sets.new')}</h2>
      <p>
        <label>
          {t('sets.slug')}{' '}
          <input value={setSlug} onChange={(e) => setSetSlug(e.target.value)} placeholder="tuan-1" />
        </label>
        <label>
          {t('sets.name')} <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t('sets.description')}{' '}
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          {t('sets.deadline')}{' '}
          <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
      </p>
      <p className="muted">{t('sets.deadlineHint')}</p>
      <ProblemPicker picked={picked} onChange={setPicked} />
      {error ? <p role="alert">{error}</p> : null}
      <p>
        {/* D148 — a homework set with twenty problems in it is not an
            instant save. */}
        <button
          type="button"
          disabled={busy || setSlug === '' || name === ''}
          aria-busy={busy}
          onClick={() => void save()}
        >
          {busy ? t('form.saving') : t('sets.save')}
        </button>{' '}
        {onCancel ? (
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        ) : null}
      </p>
    </>
  );
}

/**
 * The organization page's homework section.
 *
 * Absent entirely for a non-member: the API answers them an empty page (D66),
 * and a heading over nothing is a school that looks like it assigns nothing.
 * The assign form is behind a button rather than always open — the list is
 * what a teacher opens this page for.
 */
export function OrgSets({ slug, canManage }: { slug: string; canManage: boolean }) {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const [assigning, setAssigning] = useState(false);
  // Silent on failure, exactly as `OrgContests` is and for the same reason:
  // this section sits above the roster on somebody else's page, and a failed
  // list must not take that page down or stack a second alert on it.
  const sets = useQuery({
    queryKey: setsKey(slug),
    enabled: me.data != null,
    queryFn: async () => {
      // NOT `data?.items ?? []`. openapi-fetch RESOLVES on an HTTP error, so
      // that spelling turned every 500 into an empty array — and this panel
      // renders an empty array as `sets.empty`, "Chưa có bài tập nào": a
      // pupil told their teacher has assigned them nothing (B-8's swallow,
      // one more survivor, found by the D143 sweep).
      const result = await api.GET('/orgs/{slug}/sets', { params: { path: { slug } } });
      return read(result, t('sets.loadError'))?.items ?? [];
    },
  });

  async function refresh(): Promise<void> {
    setAssigning(false);
    await client.invalidateQueries({ queryKey: setsKey(slug) });
  }

  if (!me.data) return null;
  if (!canManage && (sets.data === undefined || sets.data.length === 0)) return null;

  return (
    <>
      <h2>{t('sets.title')}</h2>
      {sets.error ? (
        <LoadError
          error={sets.error}
          what={t('sets.loadError')}
          onRetry={() => void sets.refetch()}
        />
      ) : null}
      {sets.data && sets.data.length === 0 ? <p className="muted">{t('sets.empty')}</p> : null}
      {sets.data && sets.data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('sets.colSet')}</th>
              <th>{t('sets.colDeadline')}</th>
              <th className="num">{t('sets.colProgress')}</th>
            </tr>
          </thead>
          <tbody>
            {sets.data.map((set: SetSummary) => (
              <tr key={set.slug}>
                <td>
                  <Link to="/orgs/$slug/sets/$setSlug" params={{ slug, setSlug: set.slug }}>
                    {set.name}
                  </Link>
                </td>
                <td>
                  {set.deadline ? (
                    formatDateTime(set.deadline, locale, timeZone)
                  ) : (
                    <span className="muted">{t('sets.noDeadline')}</span>
                  )}
                </td>
                <td className="num">{t('sets.solvedOf', { done: set.solvedCount, total: set.itemCount })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canManage && !assigning ? (
        <p>
          <button type="button" onClick={() => setAssigning(true)}>
            {t('sets.new')}
          </button>
        </p>
      ) : null}
      {canManage && assigning ? (
        <SetForm slug={slug} onSaved={refresh} onCancel={() => setAssigning(false)} />
      ) : null}
    </>
  );
}

/** One set, as the pupil it was assigned to reads it. */
export function ProblemSetPage({ slug, setSlug }: { slug: string; setSlug: string }) {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const client = useQueryClient();
  const me = useQuery(meQueryOptions);
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const org = useQuery({
    queryKey: ['org', slug],
    enabled: me.data != null,
    queryFn: async () => {
      const result = await api.GET('/orgs/{slug}', { params: { path: { slug } } });
      if (result.error) throw apiError(result, t('org.notFound'));
      return result.data;
    },
  });
  const set = useQuery({
    queryKey: ['org-set', slug, setSlug],
    enabled: me.data != null,
    queryFn: async () => {
      const result = await api.GET('/orgs/{slug}/sets/{setSlug}', {
        params: { path: { slug, setSlug } },
      });
      if (result.error) throw apiError(result, t('sets.notFound'));
      return result.data;
    },
  });

  const canManage =
    org.data?.myRole === 'owner' || org.data?.myRole === 'admin' || me.data?.globalRole === 'admin';

  async function refresh(): Promise<void> {
    setEditing(false);
    await client.invalidateQueries({ queryKey: ['org-set', slug] });
    await client.invalidateQueries({ queryKey: setsKey(slug) });
  }

  async function remove(): Promise<void> {
    if (!window.confirm(t('sets.deleteConfirm'))) return;
    const { error } = await api.DELETE('/orgs/{slug}/sets/{setSlug}', {
      params: { path: { slug, setSlug } },
    });
    if (error) {
      setActionError(error.detail ?? t('sets.deleteError'));
      return;
    }
    setActionError(null);
    await client.invalidateQueries({ queryKey: setsKey(slug) });
    window.location.assign(`/orgs/${slug}`);
  }

  if (set.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (set.error) return <LoadError error={set.error} onRetry={() => void set.refetch()} />;
  if (!set.data) return null;

  const dated = set.data.deadline !== null;
  return (
    <section className="panel">
      <h1>{set.data.name}</h1>
      <p className="muted">
        <Link to="/orgs/$slug" params={{ slug }}>
          {org.data?.name ?? slug}
        </Link>
        {' · '}
        {set.data.deadline
          ? formatDateTime(set.data.deadline, locale, timeZone)
          : t('sets.noDeadline')}
        {' · '}
        {t('sets.solvedOf', { done: set.data.solvedCount, total: set.data.itemCount })}
      </p>
      {set.data.description ? (
        // The same renderer a statement uses (D10's Markdown), so a teacher
        // writes instructions the way they write everything else here.
        <div dangerouslySetInnerHTML={{ __html: renderStatement(set.data.description) }} />
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}

      <table>
        <thead>
          <tr>
            <th>{t('sets.colProblem')}</th>
            <th className="num">{t('sets.colPoints')}</th>
            <th>{t('sets.colBest')}</th>
            {dated ? <th>{t('sets.colLate')}</th> : null}
            <th />
          </tr>
        </thead>
        <tbody>
          {set.data.items.map((item: SetItem) => (
            <tr key={item.code}>
              <td>
                {item.visible ? (
                  <Link to="/problems/$code" params={{ code: item.code }}>
                    {item.name}
                  </Link>
                ) : (
                  <>
                    {item.name} <span className="muted">({t('sets.unavailable')})</span>
                  </>
                )}
              </td>
              <td className="num">{item.points}</td>
              <td>
                <VerdictCell attempt={item.me?.onTime ?? null} t={t} />
              </td>
              {dated ? (
                <td>
                  <VerdictCell attempt={item.me?.late ?? null} t={t} />
                </td>
              ) : null}
              <td>
                {item.visible ? (
                  <Link to="/submit" search={{ problem: item.code }}>
                    {t('sets.submit')}
                  </Link>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canManage ? (
        <p>
          <Link to="/orgs/$slug/sets/$setSlug/progress" params={{ slug, setSlug }}>
            {t('sets.progress')}
          </Link>{' '}
          <button type="button" onClick={() => setEditing(!editing)}>
            {t('sets.edit')}
          </button>{' '}
          <button type="button" onClick={() => void remove()}>
            {t('sets.delete')}
          </button>
        </p>
      ) : null}
      {canManage && editing ? (
        <SetForm slug={slug} existing={set.data} onSaved={refresh} onCancel={() => setEditing(false)} />
      ) : null}
    </section>
  );
}

/**
 * The teacher's grid.
 *
 * The table lives inside a `tabindex="0"` scroll container rather than
 * scrolling itself: `app.css`'s phone rule makes every `<table>` its own
 * scroller, and a scroll container that is not focusable cannot be reached
 * from a keyboard at all (WCAG 2.1.1 — final-review m21). One column per
 * problem is exactly the table that will not fit, so this is the screen that
 * has to get it right.
 */
export function ProblemSetProgressPage({ slug, setSlug }: { slug: string; setSlug: string }) {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const me = useQuery(meQueryOptions);
  // Paged, and appended: the grid is the roster (D58), so a class past the
  // first page needs a way to the rest of itself. `useInfiniteQuery`, like
  // every other "load more" in the app.
  const grid = useInfiniteQuery({
    queryKey: ['org-set-progress', slug, setSlug],
    enabled: me.data != null,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<Progress> => {
      // `exactOptionalPropertyTypes`: an absent cursor is an omitted key.
      const query: { cursor?: string } = {};
      if (pageParam !== undefined) query.cursor = pageParam;
      const result = await api.GET('/orgs/{slug}/sets/{setSlug}/progress', {
        params: { path: { slug, setSlug }, query },
      });
      if (result.error) throw apiError(result, t('sets.progressError'));
      return result.data as Progress;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  if (grid.isPending) return <p className="muted">{t('common.loading')}</p>;
  if (grid.error) return <LoadError error={grid.error} onRetry={() => void grid.refetch()} />;
  if (!grid.data) return null;

  // Every page carries the same columns and deadline — they describe the SET,
  // not the page — so the first page answers for all of them; the rows are
  // the part that accumulates.
  const head = grid.data.pages[0]!;
  const rows = grid.data.pages.flatMap((page) => page.rows);
  const dated = head.deadline !== null;
  return (
    <section className="panel">
      <h1>{t('sets.progressTitle', { name: head.name })}</h1>
      <p className="muted">
        <Link to="/orgs/$slug/sets/$setSlug" params={{ slug, setSlug }}>
          {t('sets.back')}
        </Link>
        {' · '}
        {head.deadline ? formatDateTime(head.deadline, locale, timeZone) : t('sets.noDeadline')}
        {' · '}
        {/* A plain <a>, not the SDK: the browser is downloading a file the
            server renders, and it carries the session cookie itself. */}
        <a href={csvHref(slug, setSlug)}>{t('sets.csv')}</a>
      </p>
      <div className="grid-scroll" tabIndex={0} role="region" aria-label={t('sets.gridLabel')}>
        <table>
          <thead>
            <tr>
              <th>{t('sets.colStudent')}</th>
              {head.columns.map((column) => (
                <th key={column.code} className="num">
                  <Link to="/problems/$code" params={{ code: column.code }}>
                    {column.code}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.username}>
                <td>
                  <Link to="/users/$username" params={{ username: row.username }}>
                    {row.displayName}
                  </Link>
                </td>
                {row.cells.map((cell, index) => (
                  <td key={head.columns[index]?.code ?? index} className="num">
                    <VerdictCell attempt={cell?.onTime ?? null} t={t} />
                    {dated && cell?.late ? (
                      <>
                        {' '}
                        <span className="muted">
                          (<VerdictCell attempt={cell.late} t={t} /> {t('sets.late')})
                        </span>
                      </>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {grid.hasNextPage ? (
        <p>
          <button
            type="button"
            onClick={() => void grid.fetchNextPage()}
            disabled={grid.isFetchingNextPage}
          >
            {t('common.loadMore')}
          </button>
        </p>
      ) : null}
    </section>
  );
}

/** The export's URL — the same route, `?format=csv`. */
function csvHref(slug: string, setSlug: string): string {
  const base = import.meta.env.VITE_API_ORIGIN ?? '';
  return `${base}/${API_PREFIX}/orgs/${encodeURIComponent(slug)}/sets/${encodeURIComponent(setSlug)}/progress?format=csv`;
}

/**
 * An ISO instant as `<input type="datetime-local">` wants it — local
 * wall-clock, no zone, minutes precision. `''` for no deadline, which is the
 * empty input.
 */
function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const at = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

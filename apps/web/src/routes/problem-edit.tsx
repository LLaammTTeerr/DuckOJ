import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { renderStatement } from '../markdown.js';

type ProblemDetail = paths['/problems/{code}']['get']['responses'][200]['content']['application/json'];
type Visibility = ProblemDetail['visibility'];

const VISIBILITIES: Visibility[] = ['private', 'org', 'public'];

/**
 * Splits a comma-separated org-slugs input into a clean array: trims each
 * entry and drops empties, so a trailing comma or a blank input sends `[]`
 * rather than `['']`. Deliberately does no other validation — an invalid or
 * unshareable slug comes back from the API as `problem_org_unknown` (or an
 * empty result under `visibility: 'org'` as `problem_org_required`), and
 * that error's `code` is what gets shown, verbatim, below.
 */
function parseOrgSlugs(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * `/problems/new` (no `code` prop — create) and `/problems/:code/edit`
 * (`code` supplied — edit). One component for both: the fields and the live
 * preview are identical between the two; only what's editable, and where
 * the initial values come from, differs.
 *
 * The `code` field is the one place those two modes must never blur
 * together. A problem's code is immutable — the API rejects a `code` key in
 * a PATCH body outright, with 400 `problem_code_immutable` — so a form that
 * let someone type into this field on the edit route, only to have that
 * value silently dropped on submit, would be actively misleading: worse
 * than not offering the field at all. It is `disabled` on edit and enabled
 * on create; see problem-edit.spec.tsx for the assertion on both states.
 *
 * No member editor here. Spec §1 puts that in Phase 3, alongside the user
 * picker it needs — building it now "since the endpoint exists" is exactly
 * the scope drift the brief warns against. Members are rendered read-only,
 * sourced from `ProblemDetail.members` (spec §4.1): visible to anyone who
 * can see the problem at all, unlike `orgSlugs`, which this same response
 * already filters server-side down to what THIS actor — editor or not — may
 * see (see `ProblemAccessService.loadMembersAndOrgs`'s doc comment). This
 * page never re-derives or second-guesses that filtering; it only displays
 * what the API returned and resubmits it unchanged on PATCH.
 */
export function ProblemEditPage(props: { code?: string }) {
  const isEdit = props.code !== undefined;

  const query = useQuery({
    queryKey: ['problem', props.code],
    queryFn: async () => {
      // `props.code!`: `enabled: isEdit` below means this only ever runs
      // when `props.code` is defined.
      const { data, error } = await api.GET('/problems/{code}', { params: { path: { code: props.code! } } });
      if (error) return null;
      return data;
    },
    enabled: isEdit,
    retry: false,
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [statement, setStatement] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [orgSlugsRaw, setOrgSlugsRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Pre-fills the form once the existing problem loads. Guarded by
  // `initialized` (not just `query.data`) so a later background refetch of
  // the same query never clobbers edits already in progress — this effect
  // is meant to run exactly once, the first time the fetched problem
  // becomes available.
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized || !query.data) return;
    setCode(query.data.code);
    setName(query.data.name);
    setStatement(query.data.statement);
    setVisibility(query.data.visibility);
    setOrgSlugsRaw(query.data.orgSlugs.join(', '));
    setInitialized(true);
  }, [initialized, query.data]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setSubmitError(null);
    setSaved(false);
    try {
      // openapi-fetch resolves an HTTP error response to `{ error }` rather
      // than throwing (see submit.tsx's handleSubmit for the same shape,
      // documented at more length) — that is the branch that shows the
      // server's error `code` verbatim below. A network-level failure (no
      // response at all) rethrows instead, which is what the `catch` below
      // is for.
      const { error } = isEdit
        ? await api.PATCH('/problems/{code}', {
            params: { path: { code: props.code! } },
            body: { name, statement, visibility, orgSlugs: parseOrgSlugs(orgSlugsRaw) },
          })
        : await api.POST('/problems', {
            body: { code, name, statement, visibility, orgSlugs: parseOrgSlugs(orgSlugsRaw) },
          });
      if (error) {
        // Verbatim, not paraphrased — this is a tool for people who will
        // read error codes like `problem_code_taken` or
        // `problem_org_unknown`, not a consumer app (task-12 brief).
        setSubmitError(error.code);
        return;
      }
      setSaved(true);
    } catch {
      setSubmitError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (isEdit && query.isLoading) return <p>Loading…</p>;

  return (
    <section>
      <h1>{isEdit ? `Edit ${props.code}` : 'New problem'}</h1>
      {submitError ? <p role="alert">{submitError}</p> : null}
      {saved ? <p>Saved.</p> : null}
      <form onSubmit={(e) => void handleSubmit(e)}>
        <label htmlFor="problem-code">Code</label>
        <input id="problem-code" value={code} onChange={(e) => setCode(e.target.value)} disabled={isEdit} />

        <label htmlFor="problem-name">Name</label>
        <input id="problem-name" value={name} onChange={(e) => setName(e.target.value)} />

        <label htmlFor="problem-statement">Statement</label>
        <textarea id="problem-statement" value={statement} onChange={(e) => setStatement(e.target.value)} />

        {/* Live preview via `renderStatement` (markdown.ts) — a security
            boundary whose sanitize step runs last; see that module's doc
            comment. This is the same function, and the same
            `dangerouslySetInnerHTML` contract, `problem.tsx` uses to render
            a published statement. */}
        <div data-testid="statement-preview" dangerouslySetInnerHTML={{ __html: renderStatement(statement) }} />

        <label htmlFor="problem-visibility">Visibility</label>
        <select
          id="problem-visibility"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as Visibility)}
        >
          {VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>

        <label htmlFor="problem-org-slugs">Organizations (comma-separated)</label>
        <input id="problem-org-slugs" value={orgSlugsRaw} onChange={(e) => setOrgSlugsRaw(e.target.value)} />

        <button type="submit" disabled={busy}>
          {isEdit ? 'Save' : 'Create'}
        </button>
      </form>

      {isEdit && query.data ? (
        <section>
          <h2>Members</h2>
          <ul>
            {query.data.members.map((m) => (
              <li key={m.username}>
                {m.username} — {m.role}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { paths } from '@duckoj/sdk';
import { api } from '../api.js';
import { meQueryOptions } from '../me.js';
import { renderStatement } from '../markdown.js';
import { tagsQueryOptions } from '../tags.js';
import { useLocale, useT, tagName } from '../i18n/index.js';
import { CodeAlert, type CodeAlertState } from '../states.js';
import { ProblemTestDataTab } from './problem-testdata.js';
import { ProblemLanguageLimitsTab } from './problem-language-limits.js';
import { useDirtyGuard } from '../forms.js';

type ProblemDetail = paths['/problems/{code}']['get']['responses'][200]['content']['application/json'];
type Visibility = ProblemDetail['visibility'];
type SourceAccess = ProblemDetail['sourceAccess'];

const VISIBILITIES: Visibility[] = ['private', 'org', 'public'];
// No `public` value — design 2026-08-21-submission-source-visibility-design.md
// §2.3 deliberately stops at "anyone who has solved it"; the submitter,
// admins, and the problem's authors/curators always see a submission's
// source regardless of this setting, so it is not offered as a third option
// here either.
const SOURCE_ACCESSES: SourceAccess[] = ['private', 'solved'];

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
 * The whole editable form as one comparable string (D147).
 *
 * A fingerprint rather than a field-by-field compare: the form has nine
 * editable pieces of state and a hand-written comparison would go stale the
 * first time a tenth is added — which is exactly how a dirty guard quietly
 * stops guarding. `\u0000` separates fields so no value can impersonate a
 * boundary.
 */
interface FormShape {
  name: string;
  statement: string;
  visibility: string;
  sourceAccess: string;
  orgSlugsRaw: string;
  tagSlugs: readonly string[];
  difficultyRaw: string;
  editorial: string;
  editorialPublished: boolean;
}

function fingerprint(form: FormShape): string {
  return [
    form.name,
    form.statement,
    form.visibility,
    form.sourceAccess,
    form.orgSlugsRaw,
    form.tagSlugs.join(','),
    form.difficultyRaw,
    form.editorial,
    String(form.editorialPublished),
  ].join('\u0000');
}

/** The create route's baseline: an untouched empty form is not dirty. */
const EMPTY_FORM: FormShape = {
  name: '',
  statement: '',
  visibility: 'private',
  sourceAccess: 'private',
  orgSlugsRaw: '',
  tagSlugs: [],
  difficultyRaw: '',
  editorial: '',
  editorialPublished: false,
};

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
  const t = useT();
  const { locale } = useLocale();
  const client = useQueryClient();
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
  // Edit-only (see the `<select>` below): `CreateProblemRequest` has no
  // `sourceAccess` field at all (design §5 — "a problem is created closed
  // and opened deliberately, never as a default nobody chose"), so this
  // initial value is never read on the create route.
  const [sourceAccess, setSourceAccess] = useState<SourceAccess>('private');
  const [orgSlugsRaw, setOrgSlugsRaw] = useState('');
  // Edit-only, exactly like `sourceAccess` above and for the same reason:
  // `CreateProblemRequest` carries neither field, so a problem is created
  // untagged and unrated and gets classified deliberately afterwards.
  //
  // `difficultyRaw` is the string the input holds, not a number: an empty
  // box is a real state ("nobody has said") that no number represents, and
  // parsing on every keystroke would fight the person typing "10" through
  // the intermediate "1".
  const [tagSlugs, setTagSlugs] = useState<string[]>([]);
  const [difficultyRaw, setDifficultyRaw] = useState('');
  // Edit-only as well. Two pieces of state, not one: an editorial can be
  // written and left unpublished for as long as its author wants, and the
  // publish toggle is a separate decision from the text — which is exactly
  // what `PATCH`'s two keys are.
  const [editorial, setEditorial] = useState('');
  const [editorialPublished, setEditorialPublished] = useState(false);
  const allTags = useQuery(tagsQueryOptions);
  // Two tabs on the edit route, one on the create route. The test-data tab
  // (D87) builds a package for a problem that must already exist — it needs
  // a `code` to open a draft against — so it is not offered while creating
  // one, exactly as `tags`, `difficulty` and the editorial are not.
  const [tab, setTab] = useState<'details' | 'testdata' | 'langlimits'>('details');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<CodeAlertState>(null);
  const [saved, setSaved] = useState(false);

  // Rejudging every submission of this problem is an admin operation that
  // lives here rather than on its own screen: the moment you need it is
  // right after republishing a corrected test set, which is this form.
  const me = useQuery(meQueryOptions);
  const [rejudgeBusy, setRejudgeBusy] = useState(false);
  const [rejudgeMessage, setRejudgeMessage] = useState<string | null>(null);
  const [rejudgeError, setRejudgeError] = useState<CodeAlertState>(null);
  // D21: see submission.tsx — a rejudge names the contests to re-rate and
  // replays nothing itself.
  const [reRate, setReRate] = useState<string[]>([]);

  // D88: "Nhân bản". Its own state, deliberately not part of the form above
  // — a clone is a different problem being created, not a save of this one,
  // and sharing `busy`/`submitError` would make a failed clone look like a
  // failed edit.
  const [cloneCode, setCloneCode] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneError, setCloneError] = useState<CodeAlertState>(null);
  const [cloned, setCloned] = useState<string | null>(null);

  /**
   * Clones this problem into `cloneCode`.
   *
   * The result is a LINK rather than a redirect: the copy is private, has an
   * unpublished revision and usually wants its statement edited next, so
   * landing on its edit screen is right — but so is staying here, and a
   * navigation that discarded unsaved edits to THIS form would be the worse
   * of the two. The server's own error code is shown verbatim, as everywhere
   * else on this screen (`problem_code_taken` is the one that matters).
   */
  async function handleClone(): Promise<void> {
    setCloneBusy(true);
    setCloneError(null);
    setCloned(null);
    try {
      const { data, error } = await api.POST('/problems/{code}/clone', {
        params: { path: { code: props.code! } },
        body: {
          newCode: cloneCode.trim(),
          ...(cloneName.trim() === '' ? {} : { newName: cloneName.trim() }),
        },
      });
      if (error || !data) {
        setCloneError({ message: t('problemEdit.cloneFailed'), code: error?.code });
        return;
      }
      setCloned(data.code);
    } catch {
      setCloneError({ message: t('common.networkError') });
    } finally {
      setCloneBusy(false);
    }
  }

  async function handleRejudge(): Promise<void> {
    // No undo: every verdict on this problem is discarded and re-earned.
    if (!window.confirm(t('problemEdit.rejudgeConfirm', { code: props.code ?? '' }))) {
      return;
    }
    setRejudgeBusy(true);
    setRejudgeError(null);
    setRejudgeMessage(null);
    setReRate([]);
    try {
      const { data, error } = await api.POST('/admin/problems/{code}/rejudge', {
        params: { path: { code: props.code! } },
      });
      if (error) {
        setRejudgeError({ message: t('problemEdit.rejudgeFailed'), code: error.code });
        return;
      }
      setRejudgeMessage(t('problemEdit.rejudgeQueued', { n: data.submissionsQueued }));
      setReRate(data.ratedContestKeys);
    } catch {
      // openapi-fetch rethrows network-level failures rather than resolving
      // them to `{ error }` — see submit.tsx's handleSubmit for the pattern.
      setRejudgeError({ message: t('common.networkError') });
    } finally {
      setRejudgeBusy(false);
    }
  }

  // Pre-fills the form once the existing problem loads. Guarded by
  // `initialized` (not just `query.data`) so a later background refetch of
  // the same query never clobbers edits already in progress — this effect
  // is meant to run exactly once, the first time the fetched problem
  // becomes available.
  // Which problem the form state was seeded FROM — a code, not a boolean:
  // if the route's $code changes under a reused component instance, a
  // boolean stays true and the form keeps the previous problem's content,
  // then saves it over the new one. (The route also keys this component by
  // code — router.tsx — so this is defense in depth.)
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  /**
   * Every editable field as the PROBLEM had it (D147), flattened to one
   * string so "has anything changed?" is one `!==`.
   *
   * Compared against the seed rather than against emptiness: this form
   * arrives prefilled, and a guard that fired for the problem's own statement
   * would prompt on every visit and teach setters to click through it. On the
   * create route the seed is the empty form, which is the right baseline
   * there too.
   */
  const [seed, setSeed] = useState<string>(() => fingerprint(EMPTY_FORM));
  /**
   * The `version` this form was seeded WITH — D161. Sent back as
   * `expectedVersion` on every save, so the server can refuse a write that
   * would replace somebody else's newer work with the copy this form has been
   * holding. `null` on the create route, where there is nothing to overwrite.
   */
  const [seededVersion, setSeededVersion] = useState<string | null>(null);
  /** A reseed happened: the record moved under an untouched form (D161). */
  const [reseeded, setReseeded] = useState(false);
  /** The last save was refused as a conflict, so the reload offer is on. */
  const [conflict, setConflict] = useState(false);
  const dirty =
    fingerprint({
      name,
      statement,
      visibility,
      sourceAccess,
      orgSlugsRaw,
      tagSlugs,
      difficultyRaw,
      editorial,
      editorialPublished,
    }) !== seed;
  useEffect(() => {
    if (!query.data) return;
    const first = seededFrom !== query.data.code;
    // **D161, clause A.** This used to be `seededFrom === code` and nothing
    // else: the FIRST value the form ever saw won, forever. B-31 removed the
    // way the app manufactured a stale first value; what it could not fix
    // without a ruling is a first value that was stale because SOMEBODY ELSE
    // saved. So a form that has already been seeded reseeds when two things
    // hold together:
    //
    //   - the record moved (`version` differs from the one seeded with), and
    //   - this setter has typed NOTHING (`!dirty`).
    //
    // The second half is the load-bearing one. Reseeding a dirty form would
    // be the same data loss with the victims swapped — it would throw away
    // what is on this screen instead of what is on the server. A dirty form
    // therefore keeps its typing, keeps its stale `seededVersion`, and is
    // refused by the API on save (D161's clause B) rather than allowed to
    // overwrite. That refusal is the guarantee; this clause only keeps it
    // rare enough that nobody learns to click through it.
    if (!first && (dirty || query.data.version === seededVersion)) return;
    setCode(query.data.code);
    setName(query.data.name);
    setStatement(query.data.statement);
    setVisibility(query.data.visibility);
    setSourceAccess(query.data.sourceAccess);
    setOrgSlugsRaw(query.data.orgSlugs.join(', '));
    setTagSlugs(query.data.tags.map((tag) => tag.slug));
    setDifficultyRaw(query.data.difficulty === null ? '' : String(query.data.difficulty));
    // `editorial` comes back non-null for an editor even while it is a
    // draft (D43) — that is what makes this form able to load what it is
    // about to overwrite — and `editorialAvailable` is, for an editor, the
    // publish state itself.
    setEditorial(query.data.editorial ?? '');
    setEditorialPublished(query.data.editorialAvailable);
    setSeed(
      fingerprint({
        name: query.data.name,
        statement: query.data.statement,
        visibility: query.data.visibility,
        sourceAccess: query.data.sourceAccess,
        orgSlugsRaw: query.data.orgSlugs.join(', '),
        tagSlugs: query.data.tags.map((tag) => tag.slug),
        difficultyRaw: query.data.difficulty === null ? '' : String(query.data.difficulty),
        editorial: query.data.editorial ?? '',
        editorialPublished: query.data.editorialAvailable,
      }),
    );
    setSeededVersion(query.data.version);
    setSeededFrom(query.data.code);
    // Announced, never silent. Nothing was lost — the form had nothing in it
    // to lose — and saying so is what stops a setter who looked away for a
    // minute from concluding the site ate their draft.
    if (!first) setReseeded(true);
  }, [seededFrom, seededVersion, dirty, query.data]);

  /**
   * D147. The statement box holds the largest single thing anybody types into
   * this site, and until this loop a click on the nav bar took it with no
   * prompt, no draft and no way back. (D84 gives the SUBMIT editor a stored
   * draft; nothing had ever guarded the authoring one.)
   */
  const release = useDirtyGuard(dirty);

  /**
   * D161. The setter chose to take the newer version — explicitly, by
   * pressing a button, never automatically. A conflict is by definition a
   * form holding work, and a page that silently replaced it with somebody
   * else's copy would be the very loss this whole feature exists to forbid.
   *
   * The refetch is AWAITED before the seed guard reopens. Reopening it first
   * would let the effect above seed synchronously from the entry still in the
   * cache — the stale one — which is B-31's mechanism exactly. (Clause A
   * would then correct it a round trip later, since the form is undirty by
   * that point; ordering it this way means the setter never sees the flash.)
   */
  async function loadNewer(): Promise<void> {
    setBusy(true);
    try {
      await client.invalidateQueries({ queryKey: ['problem', props.code] });
      setConflict(false);
      setSubmitError(null);
      setReseeded(false);
      setSeededFrom(null);
    } finally {
      setBusy(false);
    }
  }

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
      const { data, error } = isEdit
        ? await api.PATCH('/problems/{code}', {
            params: { path: { code: props.code! } },
            body: {
              name,
              statement,
              visibility,
              sourceAccess,
              orgSlugs: parseOrgSlugs(orgSlugsRaw),
              tags: tagSlugs,
              // An empty box sends an explicit `null` — "clear it" — rather
              // than omitting the key, which would mean "leave it alone".
              // The two are different requests (see `UpdateProblemRequest`),
              // and a form whose blank field silently kept the old value
              // would give a setter no way to un-rate a problem at all.
              difficulty: difficultyRaw.trim() === '' ? null : Number(difficultyRaw),
              // An empty box is an explicit `null` — "there is no
              // editorial" — for `difficulty`'s reason: omitting the key
              // would mean "leave it", and a setter could then never
              // withdraw an editorial from this form. The API answers 422
              // `problem_editorial_empty` if the toggle is on with nothing
              // to publish, and that code is what gets shown.
              editorial: editorial.trim() === '' ? null : editorial,
              editorialPublished,
              // D161. Omitted rather than sent as `undefined`
              // (`exactOptionalPropertyTypes` separates the two), and omitted
              // only when the server declined to give us one — which for this
              // route means the viewer may not edit, in which case the PATCH
              // is about to 403 anyway.
              ...(seededVersion === null ? {} : { expectedVersion: seededVersion }),
            },
          })
        : await api.POST('/problems', {
            body: { code, name, statement, visibility, orgSlugs: parseOrgSlugs(orgSlugsRaw) },
          });
      if (error) {
        // D161's refusal, rendered as a form failure like every other one —
        // but with an offer attached, because this is the one error the
        // setter cannot fix by retyping. `conflict` turns the button on; the
        // sentence says what happened and that nothing was written.
        if (error.code === 'problem_version_conflict') {
          setConflict(true);
          setSubmitError({ message: t('editConflict.problem'), code: error.code });
          return;
        }
        // Verbatim, not paraphrased — this is a tool for people who will
        // read error codes like `problem_code_taken` or
        // `problem_org_unknown`, not a consumer app (task-12 brief).
        setSubmitError({ message: t('problemEdit.saveFailed'), code: error.code });
        return;
      }
      // Saved: this IS the problem now, so the guard has nothing left to
      // protect — and `release()` is synchronous for the same reason
      // contest-edit's is, since a save may be followed by a navigation.
      setSeed(
        fingerprint({
          name,
          statement,
          visibility,
          sourceAccess,
          orgSlugsRaw,
          tagSlugs,
          difficultyRaw,
          editorial,
          editorialPublished,
        }),
      );
      release();
      setSaved(true);
      // D161. The PATCH answers with the problem as it now is, so this is the
      // token the form holds from here on. Without it the NEXT save from this
      // same open form would send the pre-save value and be refused as a
      // conflict with the write it had just made itself.
      if (data) setSeededVersion(data.version);
      setConflict(false);
      setReseeded(false);
      // The screens that read what was just written. `['problem', code]` is
      // the important one and NOT for cosmetic reasons: this very form is
      // prefilled from it, the seeding effect above runs ONCE per code, and a
      // remount seeds from the cache synchronously — before the mount's own
      // refetch can land. Left stale, a setter who saves, leaves and comes
      // back inside `gcTime` is shown the statement they replaced, and the
      // next save PUTs it back over the one they wrote. The sibling language
      // limits tab has always refreshed this key after ITS save (D159); the
      // form that owns the statement never did.
      //
      // `['problems']` is a prefix, so it also reaches the filtered list
      // (`['problems', q, tags, …]`) that carries the name, tags, difficulty
      // and visibility this save may have changed.
      if (isEdit) await client.invalidateQueries({ queryKey: ['problem', props.code] });
      await client.invalidateQueries({ queryKey: ['problems'] });
    } catch {
      setSubmitError({ message: t('common.networkError') });
    } finally {
      setBusy(false);
    }
  }

  if (isEdit && query.isLoading) return <p>{t('common.loading')}</p>;

  return (
    <section>
      <h1>
        {isEdit ? t('problemEdit.editTitle', { code: props.code! }) : t('problemEdit.newTitle')}
      </h1>
      {isEdit ? (
        <nav>
          <button type="button" onClick={() => setTab('details')} disabled={tab === 'details'}>
            {t('problemEdit.tabDetails')}
          </button>{' '}
          <button type="button" onClick={() => setTab('testdata')} disabled={tab === 'testdata'}>
            {t('problemEdit.tabTestData')}
          </button>{' '}
          {/* D159. A third tab rather than a block on the details form: this
              edits a different table through a different route, it saves on
              its own button, and folding it into the details PATCH would make
              one failed save able to lose the other half's typing. */}
          <button
            type="button"
            onClick={() => setTab('langlimits')}
            disabled={tab === 'langlimits'}
          >
            {t('problemEdit.tabLanguageLimits')}
          </button>
        </nav>
      ) : null}

      {isEdit && tab === 'testdata' ? <ProblemTestDataTab code={props.code!} /> : null}
      {isEdit && tab === 'langlimits' ? <ProblemLanguageLimitsTab code={props.code!} /> : null}

      {tab === 'details' ? (
        <>
      {/* `submitError` is the server's own error CODE (`problem_code_taken`)
          — deliberately verbatim, never paraphrased or translated: this is a
          tool for people who read codes (task-12 brief). */}
      {submitError ? <CodeAlert {...submitError} /> : null}
      {/* D161. Beneath the message, and a button rather than an automatic
          reload: everything the setter typed is still on screen and still
          copyable until they choose. D148 — live unless busy, and it says
          what it is doing. */}
      {conflict ? (
        <p>
          <button type="button" onClick={() => void loadNewer()} disabled={busy}>
            {busy ? t('common.loading') : t('editConflict.load')}
          </button>
        </p>
      ) : null}
      {reseeded ? <p role="status">{t('editConflict.reseeded')}</p> : null}
      {saved ? <p>{t('problemEdit.saved')}</p> : null}
      <form onSubmit={(e) => void handleSubmit(e)}>
        <label htmlFor="problem-code">{t('problemEdit.code')}</label>
        <input id="problem-code" value={code} onChange={(e) => setCode(e.target.value)} disabled={isEdit} />

        <label htmlFor="problem-name">{t('common.name')}</label>
        <input id="problem-name" value={name} onChange={(e) => setName(e.target.value)} />

        <label htmlFor="problem-statement">{t('problemEdit.statement')}</label>
        <textarea id="problem-statement" value={statement} onChange={(e) => setStatement(e.target.value)} />

        {/* Live preview via `renderStatement` (markdown.ts) — a security
            boundary whose sanitize step runs last; see that module's doc
            comment. This is the same function, and the same
            `dangerouslySetInnerHTML` contract, `problem.tsx` uses to render
            a published statement. */}
        <div data-testid="statement-preview" dangerouslySetInnerHTML={{ __html: renderStatement(statement) }} />

        <label htmlFor="problem-visibility">{t('common.visibility')}</label>
        <select
          id="problem-visibility"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as Visibility)}
        >
          {/* The `value` is the API's enum; the label is the word for it. */}
          {VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {t(`visibility.${v}`)}
            </option>
          ))}
        </select>

        {/* Edit-only: `CreateProblemRequest` carries no `sourceAccess` field
            at all (design §5), so there is nothing to render or submit here
            on the create route. */}
        {isEdit ? (
          <>
            <label htmlFor="problem-source-access">{t('problemEdit.sourceAccess')}</label>
            <select
              id="problem-source-access"
              value={sourceAccess}
              onChange={(e) => setSourceAccess(e.target.value as SourceAccess)}
            >
              {/* Unlike `visibility.*`, these are full human-meaning
                  sentences, not one-word labels — the enum value alone
                  ("solved") does not say who it lets in. */}
              {SOURCE_ACCESSES.map((s) => (
                <option key={s} value={s}>
                  {t(`sourceAccess.${s}`)}
                </option>
              ))}
            </select>
          </>
        ) : null}

        {/* Checkboxes, not a comma-separated box like `orgSlugs` above:
            the tag vocabulary is closed and short, so a picker can show
            all of it and a typo is not representable. Org slugs are open
            and unbounded, which is why that field stays free text. */}
        {isEdit ? (
          <fieldset>
            <legend>{t('problemEdit.tags')}</legend>
            {(allTags.data ?? []).map((tag) => (
              <label key={tag.slug} htmlFor={`edit-tag-${tag.slug}`}>
                <input
                  id={`edit-tag-${tag.slug}`}
                  type="checkbox"
                  checked={tagSlugs.includes(tag.slug)}
                  onChange={() =>
                    setTagSlugs((current) =>
                      current.includes(tag.slug)
                        ? current.filter((slug) => slug !== tag.slug)
                        : [...current, tag.slug],
                    )
                  }
                />{' '}
                {tagName(locale, tag)}
              </label>
            ))}
          </fieldset>
        ) : null}

        {isEdit ? (
          <>
            <label htmlFor="problem-difficulty">{t('problemEdit.difficulty')}</label>
            <input
              id="problem-difficulty"
              type="number"
              min={1}
              max={10}
              value={difficultyRaw}
              onChange={(e) => setDifficultyRaw(e.target.value)}
            />
          </>
        ) : null}

        {/* Edit-only, like `tags` and `difficulty` above: a problem is
            created without an editorial and gets one once it has been set.
            The preview is the same `renderStatement` the problem page
            renders it with, so what is proofread here is what a reader
            gets. */}
        {isEdit ? (
          <>
            <label htmlFor="problem-editorial">{t('problemEdit.editorial')}</label>
            <textarea
              id="problem-editorial"
              value={editorial}
              onChange={(e) => setEditorial(e.target.value)}
            />
            <div
              data-testid="editorial-preview"
              dangerouslySetInnerHTML={{ __html: renderStatement(editorial) }}
            />
            <label htmlFor="problem-editorial-published">
              <input
                id="problem-editorial-published"
                type="checkbox"
                checked={editorialPublished}
                onChange={(e) => setEditorialPublished(e.target.checked)}
              />{' '}
              {t('problemEdit.editorialPublished')}
            </label>
            <p>{t('problemEdit.editorialHint')}</p>
          </>
        ) : null}

        <label htmlFor="problem-org-slugs">{t('problemEdit.orgSlugs')}</label>
        <input id="problem-org-slugs" value={orgSlugsRaw} onChange={(e) => setOrgSlugsRaw(e.target.value)} />

        {/* D148 — a save of a long statement is not instant, and a button
            that only goes grey is indistinguishable from a click nothing
            heard. */}
        <button type="submit" disabled={busy} aria-busy={busy}>
          {busy ? t('form.saving') : isEdit ? t('common.save') : t('common.create')}
        </button>
      </form>

      {isEdit && me.data?.globalRole === 'admin' ? (
        <section>
          <h2>{t('submission.rejudge')}</h2>
          <p>
            <button type="button" disabled={rejudgeBusy} onClick={() => void handleRejudge()}>
              {t('problemEdit.rejudgeAll')}
            </button>
          </p>
          {/* One status line, not two: `role="status"` is announced, and two
              live regions firing at once talk over each other. Contest keys
              are content and are never translated. */}
          {rejudgeMessage ? (
            <p role="status">
              {rejudgeMessage}
              {reRate.length > 0 ? ` ${t('rejudge.reRate', { keys: reRate.join(', ') })}` : ''}
            </p>
          ) : null}
          {rejudgeError ? <CodeAlert {...rejudgeError} /> : null}
        </section>
      ) : null}

      {isEdit ? (
        <section>
          <h2>{t('problemEdit.clone')}</h2>
          <p>{t('problemEdit.cloneHint')}</p>
          <label htmlFor="problem-clone-code">{t('problemEdit.cloneCode')}</label>
          <input
            id="problem-clone-code"
            value={cloneCode}
            onChange={(e) => setCloneCode(e.target.value)}
            placeholder="aplusb-2"
          />
          <label htmlFor="problem-clone-name">{t('problemEdit.cloneName')}</label>
          <input id="problem-clone-name" value={cloneName} onChange={(e) => setCloneName(e.target.value)} />
          <p>
            <button
              type="button"
              disabled={cloneBusy || cloneCode.trim() === ''}
              onClick={() => void handleClone()}
            >
              {t('problemEdit.cloneButton')}
            </button>
          </p>
          {cloneError ? <CodeAlert {...cloneError} /> : null}
          {cloned ? (
            <p role="status">
              {t('problemEdit.cloned', { code: cloned })}{' '}
              <a href={`/problems/${cloned}/edit`}>{t('problemEdit.clonedLink')}</a>
            </p>
          ) : null}
        </section>
      ) : null}

      {isEdit && query.data ? (
        <section>
          <h2>{t('problemEdit.members')}</h2>
          <ul>
            {query.data.members.map((m) => (
              <li key={m.username}>
                {m.username} — {t(`problemRole.${m.role}`)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
        </>
      ) : null}
    </section>
  );
}

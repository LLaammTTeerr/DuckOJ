import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { meQueryOptions } from '../me.js';
import { api } from '../api.js';
import { API_PREFIX } from '@duckoj/api-prefix';
import { renderStatement } from '../markdown.js';
import { useLocale, useT, tagName } from '../i18n/index.js';

// The API deliberately returns the same 404 `problem_not_found` for a
// problem that does not exist and one the caller may not see (spec §3,
// global constraint 2) — the two are indistinguishable on purpose, so an
// actor probing for private problem codes learns nothing. This page must
// not undo that by rendering a different message, a different page shape,
// or a distinguishable loading state for the two cases: both paths through
// this component render exactly the same message (`problem.notFound`, one
// key in both catalogues), and nothing here echoes `error.detail` (server
// wording could drift; the parity guarantee must not).
function statementPdfUrl(code: string): string {
  return `${import.meta.env.VITE_API_ORIGIN ?? ''}/${API_PREFIX}/problems/${code}/statement.pdf`;
}

/**
 * `/problems/:code`. `code` is passed in as a prop rather than read from
 * `window.location` here, so this component is testable without mocking
 * navigation — see main.tsx for how the path segment becomes this prop.
 */
export function ProblemPage(props: { code: string }) {
  const { code } = props;
  const t = useT();
  const { locale } = useLocale();

  const query = useQuery({
    queryKey: ['problem', code],
    queryFn: async () => {
      // openapi-fetch resolves an HTTP error response (here, always 404 —
      // see the generated type) to `{ error }` rather than throwing; a
      // genuine network-level failure (refused connection, DNS, the API
      // restarting mid-request) has no `onError` middleware registered and
      // rethrows instead, which is why this function has no try/catch of
      // its own — that case is left to propagate into `query.isError`
      // below, distinct from (and not to be confused with) the API's own
      // 404. See submit.tsx's `fetchSubmission`/`handleSubmit` for the same
      // shape, documented at more length.
      const { data, error } = await api.GET('/problems/{code}', { params: { path: { code } } });
      if (error) return null; // absent or invisible — the API does not distinguish, and neither may this page
      return data;
    },
    retry: false,
  });

  const me = useQuery(meQueryOptions);

  if (query.isLoading) return <p>{t('common.loading')}</p>;
  if (query.isError) {
    return <p role="alert">{t('problem.loadError')}</p>;
  }
  if (!query.data) return <p>{t('problem.notFound')}</p>;

  const problem = query.data;
  // `?? null`, not a bare read: the field is required by the contract, but
  // a browser holding this bundle can be talking to an API deployed before
  // it, and `renderStatement(undefined)` would white-screen the whole
  // problem page over a section that is meant to be optional.
  const editorial = problem.editorial ?? null;
  // Courtesy links only — both target pages re-decide authorization. A
  // member or a global setter/admin authors; everyone else just reads.
  const canAuthor =
    me.data != null &&
    (me.data.globalRole !== 'user' ||
      (problem.members ?? []).some((m) => m.username === me.data!.username));

  return (
    <section>
      <h1>
        {problem.name} <small>({problem.code})</small>
      </h1>
      <p>
        {/* `ms`/`KB` are unit symbols, not words — untranslated on purpose. */}
        {t('problem.limits', {
          time: problem.timeMs !== null ? `${problem.timeMs} ms` : '—',
          memory: problem.memoryKb !== null ? `${problem.memoryKb} KB` : '—',
        })}
      </p>
      {/* Topics and difficulty. Absent entirely — not an empty row — when
          the problem carries neither, which is also what a viewer sitting a
          running contest that uses this problem sees: D35 blanks both to
          exactly the values an untagged, unrated problem returns, so this
          page cannot tell the two apart and must not try. Each chip links
          into the filtered list, per "every entity is a hyperlink". */}
      {problem.tags.length > 0 || problem.difficulty !== null ? (
        <p>
          {problem.difficulty !== null
            ? `${t('problem.difficulty')}: ${String(problem.difficulty)}/10 `
            : null}
          {problem.tags.map((tag) => (
            <span key={tag.slug}>
              <Link className="tag" to="/problems" search={{ tag: [tag.slug] }}>
                {tagName(locale, tag)}
              </Link>{' '}
            </span>
          ))}
        </p>
      ) : null}
      {/* Statements are Markdown, sanitized client-side by renderStatement
          (see markdown.ts) — this is the one place in the app that hands
          rendered HTML straight to the DOM, and it is only safe because
          renderStatement's output has already been through
          DOMPurify.sanitize. */}
      <div dangerouslySetInnerHTML={{ __html: renderStatement(problem.statement) }} />
      {/* The editorial (D43), behind a `<details>` a reader has to open:
          this is the one part of the page nobody should meet by accident,
          and the API deciding they MAY read it is not the same as them
          wanting to right now.

          Rendered whenever `editorial` is non-null rather than on
          `editorialAvailable`, which is the same condition for every viewer
          who cannot edit this problem — the API hands a non-null editorial
          to no one else without also setting the flag. An editor is the one
          viewer who can see their own unpublished draft here, marked as
          one, so the page they proofread is the page a reader will get.

          Same `renderStatement` contract as the statement above: Markdown
          and maths, sanitized by DOMPurify last (markdown.ts). */}
      {editorial !== null ? (
        <details>
          <summary>
            {t('problem.editorial')}
            {problem.editorialAvailable ? null : ` (${t('problem.editorialDraft')})`}
          </summary>
          <div dangerouslySetInnerHTML={{ __html: renderStatement(editorial) }} />
        </details>
      ) : null}
      <p>
        {/* `search` is a structured object, not a hand-built query string —
            TanStack Router owns serializing it (see router.tsx's
            `submitRoute.validateSearch` and submit.tsx's `SubmitPage` doc
            comment for why that distinction is load-bearing for a problem
            code, not cosmetic). This component is unit-tested by rendering
            it directly (test/problems.spec.tsx's `ProblemPage` describe
            block), so that test now wraps its render in a router context
            for `<Link>` to resolve — see that file. */}
        <Link to="/submit" search={{ problem: problem.code }}>
          {t('common.submitSolution')}
        </Link>{' '}
        {/* A plain <a>, like the /api/v1/docs nav link: the PDF is the
            API's own response, outside this router's tree. On a server
            with no typst configured it answers an honest 501. */}
        <a href={statementPdfUrl(problem.code)}>{t('problem.pdf')}</a>{' '}
        <Link to="/submissions" search={{ problem: problem.code }}>
          {t('common.allSubmissions')}
        </Link>
        {me.data ? (
          <>
            {' '}
            <Link to="/submissions" search={{ problem: problem.code, user: me.data.username }}>
              {t('common.mySubmissions')}
            </Link>
          </>
        ) : null}
        {canAuthor ? (
          <>
            {' '}
            <Link to="/problems/$code/edit" params={{ code: problem.code }}>
              {t('problem.edit')}
            </Link>{' '}
            <Link to="/problems/$code/revisions" params={{ code: problem.code }}>
              {t('problem.revisions')}
            </Link>
          </>
        ) : null}
      </p>
    </section>
  );
}

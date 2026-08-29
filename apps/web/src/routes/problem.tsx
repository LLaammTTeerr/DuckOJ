import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { meQueryOptions } from '../me.js';
import { api } from '../api.js';
import { API_PREFIX } from '@duckoj/api-prefix';
import { renderStatement } from '../markdown.js';
import { useT } from '../i18n/index.js';

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
      {/* Statements are Markdown, sanitized client-side by renderStatement
          (see markdown.ts) — this is the one place in the app that hands
          rendered HTML straight to the DOM, and it is only safe because
          renderStatement's output has already been through
          DOMPurify.sanitize. */}
      <div dangerouslySetInnerHTML={{ __html: renderStatement(problem.statement) }} />
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

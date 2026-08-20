import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { renderStatement } from '../markdown.js';

// The API deliberately returns the same 404 `problem_not_found` for a
// problem that does not exist and one the caller may not see (spec §3,
// global constraint 2) — the two are indistinguishable on purpose, so an
// actor probing for private problem codes learns nothing. This page must
// not undo that by rendering a different message, a different page shape,
// or a distinguishable loading state for the two cases: both paths through
// this component render exactly the literal string below, and nothing here
// echoes `error.detail` (server wording could drift; the parity guarantee
// must not).
const NOT_FOUND_MESSAGE = 'No such problem.';

/**
 * `/problems/:code`. `code` is passed in as a prop rather than read from
 * `window.location` here, so this component is testable without mocking
 * navigation — see main.tsx for how the path segment becomes this prop.
 */
export function ProblemPage(props: { code: string }) {
  const { code } = props;

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

  if (query.isLoading) return <p>Loading…</p>;
  if (query.isError) {
    return <p role="alert">Could not load this problem. Check your connection and try again.</p>;
  }
  if (!query.data) return <p>{NOT_FOUND_MESSAGE}</p>;

  const problem = query.data;

  return (
    <section>
      <h1>
        {problem.name} <small>({problem.code})</small>
      </h1>
      <p>
        Limits: {problem.timeMs !== null ? `${problem.timeMs} ms` : '—'} /{' '}
        {problem.memoryKb !== null ? `${problem.memoryKb} KB` : '—'}
      </p>
      {/* Statements are Markdown, sanitized client-side by renderStatement
          (see markdown.ts) — this is the one place in the app that hands
          rendered HTML straight to the DOM, and it is only safe because
          renderStatement's output has already been through
          DOMPurify.sanitize. */}
      <div dangerouslySetInnerHTML={{ __html: renderStatement(problem.statement) }} />
      <p>
        {/* Deliberately a plain `<a>`, not `<Link>`: this component is
            unit-tested by rendering it directly with `code` as a prop (see
            this file's own doc comment above and test/problems.spec.tsx),
            with no `RouterProvider` above it, and `<Link>` throws outside
            one. A full page load here is unchanged behaviour, not a
            regression — see router.tsx and this task's report. */}
        <a href={`/submit?problem=${encodeURIComponent(problem.code)}`}>Submit a solution</a>
      </p>
    </section>
  );
}

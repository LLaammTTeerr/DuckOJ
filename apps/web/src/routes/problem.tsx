import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { hideDuplicateSampleTables } from '@duckoj/statement-samples';
import { meQueryOptions } from '../me.js';
import { api } from '../api.js';
import { API_PREFIX } from '@duckoj/api-prefix';
import { renderStatement } from '../markdown.js';
import { verdictToken } from './submit.js';
import { formatDateTime, useLocale, useT, tagName, verdictName } from '../i18n/index.js';

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
  // `?? []` for the same reason `editorial` is read with `?? null`: this
  // bundle can be talking to an API deployed before D94, which sends no
  // `samples` key, and `.map` on undefined would white-screen the page a
  // competitor came for over a section that is meant to be a bonus.
  const samples = problem.samples ?? [];
  // The shape `@duckoj/statement-samples` compares in: a table's third column
  // is a `note`, and the manifest's is an `explanation`. Mapping them onto one
  // key is what lets the duplicate check see that a table carrying the same
  // sentence IS a duplicate — without it, every annotated sample would leave
  // its table on screen.
  const asTableRows = samples.map((sample) => ({
    input: sample.input,
    output: sample.output,
    ...(sample.explanation === null ? {} : { note: sample.explanation }),
  }));
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
          {problem.tags.length > 0 ? `${t('problem.tags')}: ` : null}
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
          DOMPurify.sanitize.

          `hideDuplicateSampleTables` first (D94): when the API hands over
          structured samples AND the statement's `## Ví dụ` table says exactly
          the same thing, the table is dropped so the reader does not meet the
          same two examples twice. A table that differs at all — an extra
          example, an explanation the samples do not carry — is left alone;
          hiding a reader's only copy of something is a far worse failure
          than showing it twice. */}
      <div
        dangerouslySetInnerHTML={{
          __html: renderStatement(hideDuplicateSampleTables(problem.statement, asTableRows)),
        }}
      />
      <ProblemSamples samples={samples} />
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
      <ProblemStatsSection code={problem.code} />
    </section>
  );
}

/**
 * One sample file, with a button that copies it.
 *
 * A `<pre>` and not a table cell: what is shown is the file the judge feeds
 * the program, whitespace and all, and a table would reflow it. The copy
 * button is why the samples are worth rendering from data at all — the
 * statement's table has always shown the same characters, but you cannot
 * copy a cell out of it without picking up backticks.
 */
function SampleFile(props: { label: string; text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      // `navigator.clipboard` is absent over plain HTTP and in some embedded
      // browsers (security.tsx meets the same wall). The bytes are on screen
      // either way, so a refusal must never look like a failure to show
      // them: the button simply does not flip to "copied".
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <p>
        <strong>{props.label}</strong>{' '}
        <button type="button" onClick={() => void copy()}>
          {copied ? t('problem.sampleCopied') : t('problem.sampleCopy')}
        </button>
      </p>
      <pre>
        <code>{props.text}</code>
      </pre>
    </div>
  );
}

/**
 * "Ví dụ" — the samples, rendered from the package's own files (D94).
 *
 * Below the statement, not inside it: the statement is one Markdown string
 * this page does not edit beyond hiding a table it can prove is a duplicate,
 * and threading a React subtree into the middle of `dangerouslySetInnerHTML`
 * would mean parsing and re-emitting the whole document.
 *
 * Renders nothing at all when there are no samples — for a problem with no
 * published revision, and for one whose package could not be read, the API
 * answers `[]` and the statement's own table is still there.
 */
function ProblemSamples(props: { samples: { input: string; output: string; explanation: string | null; truncated: boolean }[] }) {
  const t = useT();
  if (props.samples.length === 0) return null;
  return (
    <section className="samples">
      <h2>{t('problem.samples')}</h2>
      {props.samples.map((sample, index) => (
        // The index IS the identity here: a sample has no id, and the list
        // belongs to one published revision, so it never reorders on screen.
        <div className="sample" key={index}>
          <h3>
            {t('problem.sampleN', { n: index + 1 })}
            {sample.truncated ? ` (${t('problem.sampleTruncated')})` : ''}
          </h3>
          <div className="side-by-side">
            <SampleFile label={t('problem.sampleInput')} text={sample.input} />
            <SampleFile label={t('problem.sampleOutput')} text={sample.output} />
          </div>
          {/* The setter's prose, through the same Markdown + maths + DOMPurify
              pipeline the statement goes through: an explanation routinely
              carries `$1 + 2 + 3$`, and rendering it as plain text would make
              hiding the table that showed it properly a downgrade. */}
          {sample.explanation !== null ? (
            <div dangerouslySetInnerHTML={{ __html: renderStatement(sample.explanation) }} />
          ) : null}
        </div>
      ))}
    </section>
  );
}

/**
 * "Thống kê" — the problem's submission statistics (D49).
 *
 * Its own query, and its own component, so a slow aggregate never delays the
 * statement: the page a competitor came for renders while this is still in
 * flight. An error here is SILENT — the section simply does not appear —
 * because statistics are commentary on the problem, and a red banner over a
 * statement because a count could not be totalled would be the tail wagging
 * the dog.
 *
 * Every count is `0` and every list empty both for a problem nobody has
 * attempted and for a viewer sitting a running contest that uses it (D35):
 * the API returns the same shape for both, deliberately, so this component
 * cannot tell them apart and must not try.
 */
function ProblemStatsSection({ code }: { code: string }) {
  const t = useT();
  const { locale, timeZone } = useLocale();
  const query = useQuery({
    queryKey: ['problem-stats', code],
    queryFn: async () => {
      const { data, error } = await api.GET('/problems/{code}/stats', {
        params: { path: { code } },
      });
      if (error) return null;
      return data;
    },
    retry: false,
  });

  const stats = query.data;
  if (!stats) return null;
  return (
    <section>
      <h2>{t('problem.stats')}</h2>
      <p>
        {t('problem.statsSummary', {
          total: String(stats.totalSubmissions),
          attempted: String(stats.attemptedUsers),
          solved: String(stats.solvedUsers),
          // A percentage with no decimals: the difference between 41 % and
          // 41.3 % is not a fact anybody acts on. `—` when there is nothing
          // to divide — the API sends `null`, never a 0 % nobody earned.
          rate:
            stats.acceptanceRate === null
              ? '—'
              : `${String(Math.round(stats.acceptanceRate * 100))}%`,
        })}
      </p>
      {stats.verdicts.length > 0 ? (
        <p>
          {stats.verdicts.map((bucket) => (
            <span key={bucket.key}>
              {/* The same badge the submissions list draws, so a verdict
                  reads identically wherever it appears. */}
              <span
                className={`badge ${verdictToken(bucket.key)}`}
                title={verdictName(t, bucket.key)}
              >
                {bucket.key}
              </span>{' '}
              {bucket.count}{' '}
            </span>
          ))}
        </p>
      ) : null}
      {stats.languages.length > 0 ? (
        <p className="muted">
          {stats.languages.map((bucket) => `${bucket.key} ${String(bucket.count)}`).join(' · ')}
        </p>
      ) : null}
      {stats.firstSolver ? (
        <p>
          {t('problem.statsFirstSolver')}{' '}
          <Link to="/users/$username" params={{ username: stats.firstSolver.username }}>
            {stats.firstSolver.username}
          </Link>{' '}
          <span className="muted">{formatDateTime(stats.firstSolver.createdAt, locale, timeZone)}</span>
        </p>
      ) : null}
      {stats.fastest.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('problem.statsColUser')}</th>
              <th className="num">{t('problem.statsColTime')}</th>
              <th className="num">{t('problem.statsColMemory')}</th>
              <th>{t('problem.statsColSubmission')}</th>
            </tr>
          </thead>
          <tbody>
            {stats.fastest.map((row) => (
              <tr key={row.submissionId}>
                <td>
                  <Link to="/users/$username" params={{ username: row.username }}>
                    {row.username}
                  </Link>
                </td>
                <td className="num">{row.timeMs} ms</td>
                <td className="num">{row.memoryKb === null ? '—' : `${row.memoryKb} KB`}</td>
                <td>
                  {/* Every entity is a hyperlink. The submission page decides
                      for itself whether this viewer may open it — the
                      statistics disclose that somebody solved the problem and
                      how fast, never their source. */}
                  <Link to="/submissions/$id" params={{ id: String(row.submissionId) }}>
                    #{row.submissionId}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

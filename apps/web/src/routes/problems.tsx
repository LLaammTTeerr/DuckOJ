import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api.js';
import { apiError } from '../api-error.js';
import { verdictToken } from './submit.js';
import { meQueryOptions } from '../me.js';
import { tagsQueryOptions } from '../tags.js';
import { useLocale, useT, tagName, verdictName } from '../i18n/index.js';

/**
 * `memoryKb` (what the API returns, and what a problem's manifest stores)
 * formatted for a human at the edge, not converted anywhere upstream of
 * this — see this file's history / the task report for why `65536 KB` is a
 * regression from the approved mockup (`docs/design/mockup-v1.html`, screen
 * 1: `64M`), not a stylistic choice.
 *
 * A whole number of MB (the overwhelmingly common case — every seeded
 * problem's limit is a round number of MB) renders bare: `64 MB`. A value
 * that is NOT a whole MB (a manifest could in principle set an odd KB
 * figure; nothing in the schema forbids it) renders to one decimal place —
 * `1.5 MB` — rather than either silently rounding (which would lose
 * information a setter might need) or falling back to the unreadable raw KB
 * this task exists to get rid of.
 */
export function formatMemoryMb(memoryKb: number | null): string {
  if (memoryKb === null) return '—';
  const mb = memoryKb / 1024;
  const rounded = Math.round(mb);
  return Number.isInteger(mb) ? `${rounded} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * The filter half of `/problems`' URL — everything a teacher can put in a
 * link and send to a class. `q` is deliberately NOT here: a search box is a
 * transient act while the filters are the description of a practice set, and
 * pushing a URL on every keystroke would bury the back button.
 */
export interface ProblemFilterValues {
  tags: string[];
  difficultyMin?: number | undefined;
  difficultyMax?: number | undefined;
}

/**
 * `"7"` -> `7`, `""` -> undefined, anything outside 1–10 -> undefined.
 *
 * Out-of-range values are dropped rather than clamped or sent: the API
 * answers 422 for them (`DifficultyQuery`), and a filter box that turned a
 * typo into an error banner over the whole list would be a worse answer than
 * one that treats "not a difficulty" as "no bound".
 */
export function parseDifficulty(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10) return undefined;
  return value;
}

/**
 * `/problems`: a search box bound to `q`, a table of code/name/limits/tests/
 * me, and a "load more" button driven by the API's opaque `nextCursor`. Uses
 * `useInfiniteQuery` so "load more" appends a page onto what's already on
 * screen instead of replacing it, while a change to the search box starts a
 * fresh query (a new `queryKey`, not another page of the old one).
 *
 * The mockup's `tests` column (screen 1) IS rendered here now that
 * `ProblemSummaryDto` carries `testCount` (`packages/contracts/src/
 * problems.ts`) — added specifically so this list can show it without a
 * request per row. Null exactly when `timeMs`/`memoryKb` are: a problem
 * whose only revision is a draft has no published limits or test count.
 *
 * `me` (spec `2026-08-21-best-verdict-design.md`) is server-computed on
 * `ProblemSummaryDto` — the viewer's best verdict on the problem, `null` for
 * an anonymous caller or one they have never (successfully graded a)
 * submission to. This is deliberately NOT backed by a client-side derivation
 * of any kind, even as a fallback: `GET /submissions?user=` is gone from
 * this file entirely, one request becomes zero, and there is exactly one
 * source of truth for the column. See that spec's §1 for why the prior
 * client-side "latest, within the last 100" version was wrong on both axes.
 */
export function ProblemsPage(props: {
  /**
   * The filters this page opens with, seeded from the URL by
   * `ProblemsRouteComponent` (router.tsx). Seeds, not a controlled value:
   * the route keys this component by them, so a change from OUTSIDE (a
   * chip link, a nav click, the back button) remounts with fresh seeds,
   * while a click inside the filter bar updates local state and then tells
   * the URL through `onFiltersChange`.
   */
  initialFilters?: ProblemFilterValues;
  onFiltersChange?: (next: ProblemFilterValues) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const me = useQuery(meQueryOptions);
  const allTags = useQuery(tagsQueryOptions);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<ProblemFilterValues>(props.initialFilters ?? { tags: [] });

  /** One place both halves of "change a filter" happen: state, then URL. */
  function applyFilters(next: ProblemFilterValues): void {
    setFilters(next);
    props.onFiltersChange?.(next);
  }

  function toggleTag(slug: string): void {
    const tags = filters.tags.includes(slug)
      ? filters.tags.filter((s) => s !== slug)
      : [...filters.tags, slug];
    applyFilters({ ...filters, tags });
  }

  const query = useInfiniteQuery({
    // Every filter is in the key: a page fetched under one filter set is a
    // different resource from the same page under another, and reusing the
    // cached entry across them is how a "load more" cursor from the old
    // list ends up appending rows the new filter excludes.
    queryKey: ['problems', q, filters.tags, filters.difficultyMin, filters.difficultyMax],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      // `exactOptionalPropertyTypes` (tsconfig.base.json) forbids assigning
      // `undefined` to an optional property outright — an omitted key and a
      // key explicitly set to `undefined` are distinct types here — so an
      // empty search or an absent cursor must be left out of the object
      // entirely rather than included as `undefined`.
      const queryParams: {
        q?: string;
        cursor?: string;
        tag?: string[];
        difficultyMin?: number;
        difficultyMax?: number;
      } = {};
      if (q !== '') queryParams.q = q;
      if (pageParam !== undefined) queryParams.cursor = pageParam;
      if (filters.tags.length > 0) queryParams.tag = filters.tags;
      if (filters.difficultyMin !== undefined) queryParams.difficultyMin = filters.difficultyMin;
      if (filters.difficultyMax !== undefined) queryParams.difficultyMax = filters.difficultyMax;
      const result = await api.GET('/problems', { params: { query: queryParams } });
      if (result.error || !result.data) {
        throw apiError(result, t('problems.loadError'));
      }
      return result.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const problems = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <h1>{t('problems.title')}</h1>
      {me.data && me.data.globalRole !== 'user' ? (
        <p>
          <Link to="/problems/new">{t('problems.new')}</Link>
        </p>
      ) : null}
      <label htmlFor="problem-search">{t('common.search')}</label>
      <input id="problem-search" value={q} onChange={(e) => setQ(e.target.value)} />

      {/* The filter bar. A `<fieldset>` with 25 checkboxes rather than a
          `<select multiple>`: a multi-select hides everything not scrolled
          to, needs ctrl-click to add a second value, and is the single
          worst-supported control on a phone — which is what half this
          province will be holding. Every box is an ordinary label+input
          pair, so the whole thing works with a keyboard and a screen
          reader with no ARIA of its own. */}
      <fieldset>
        <legend>{t('problems.filterTopics')}</legend>
        {(allTags.data ?? []).map((tag) => (
          <label key={tag.slug} htmlFor={`tag-${tag.slug}`}>
            <input
              id={`tag-${tag.slug}`}
              type="checkbox"
              checked={filters.tags.includes(tag.slug)}
              onChange={() => toggleTag(tag.slug)}
            />{' '}
            {tagName(locale, tag)}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>{t('problems.filterDifficulty')}</legend>
        <label htmlFor="difficulty-min">{t('problems.difficultyFrom')}</label>
        {/* `type="number"` with the API's own bounds, so a phone offers a
            numeric keypad and the browser refuses 0 and 11 before a
            request that could only 422 is made. `parseDifficulty` still
            treats anything out of range as "no bound" — the attribute is
            a hint, not a guarantee. */}
        <input
          id="difficulty-min"
          type="number"
          min={1}
          max={10}
          value={filters.difficultyMin ?? ''}
          onChange={(e) => applyFilters({ ...filters, difficultyMin: parseDifficulty(e.target.value) })}
        />
        <label htmlFor="difficulty-max">{t('problems.difficultyTo')}</label>
        <input
          id="difficulty-max"
          type="number"
          min={1}
          max={10}
          value={filters.difficultyMax ?? ''}
          onChange={(e) => applyFilters({ ...filters, difficultyMax: parseDifficulty(e.target.value) })}
        />
        <button type="button" onClick={() => applyFilters({ tags: [] })}>
          {t('problems.clearFilters')}
        </button>
      </fieldset>

      {query.isLoading ? <p>{t('common.loading')}</p> : null}
      {query.isError ? <p role="alert">{t('problems.loadError')}</p> : null}

      {problems.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('problems.colCode')}</th>
              <th>{t('problems.colName')}</th>
              <th className="num">{t('problems.colTime')}</th>
              <th className="num">{t('problems.colMem')}</th>
              <th className="num">{t('problems.colTests')}</th>
              <th className="num">{t('problems.colSolved')}</th>
              <th className="num">{t('problems.colDifficulty')}</th>
              <th>{t('problems.colTags')}</th>
              <th>{t('problems.colMe')}</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((p) => (
              <tr key={p.id}>
                <td>
                  {/* This component is unit-tested by rendering it directly
                      (test/problems.spec.tsx), with no `RouterProvider`
                      above it by default — `<Link>` throws outside one — so
                      that test now wraps its render in a minimal router
                      context for `<Link>` to resolve. See that file. */}
                  <Link to="/problems/$code" params={{ code: p.code }}>
                    {p.code}
                  </Link>
                </td>
                <td>
                  <Link to="/problems/$code" params={{ code: p.code }}>
                    {p.name}
                  </Link>
                </td>
                {/* Two right-aligned numeric columns, not one free-text
                    cell — tabular numerals only earn their keep when a
                    magnitude lines up under the one above it, which
                    `1000 ms / 65536 KB` concatenated into prose threw
                    away entirely. */}
                <td className="num">{p.timeMs !== null ? `${p.timeMs} ms` : '—'}</td>
                <td className="num">{formatMemoryMb(p.memoryKb)}</td>
                <td className="num">{p.testCount ?? '—'}</td>
                {/* "solved / attempted" in one cell (D49): the ratio is the
                    number a reader wants, and two columns of counts would
                    push the tags off a phone. `0 / 0` is honest for a
                    problem nobody has touched AND for one whose statistics
                    D35 is withholding — the API returns the same pair for
                    both, deliberately, exactly as it does for tags. */}
                <td className="num">
                  {p.solvedCount} / {p.attemptedCount}
                </td>
                <td className="num">{p.difficulty ?? '—'}</td>
                <td>
                  {/* Chips are LINKS, not decoration — "every entity is a
                      hyperlink" (conventions). Clicking one REPLACES the
                      filter with that single tag rather than adding to it:
                      a chip on a row means "show me this topic", and the
                      checkbox bar is where a set gets built up. An empty
                      cell here is honest for an untagged problem AND for
                      one whose tags D35 is withholding — the API returns
                      the same `[]` for both, deliberately. */}
                  {p.tags.map((tag) => (
                    <span key={tag.slug}>
                      <Link className="tag" to="/problems" search={{ tag: [tag.slug] }}>
                        {tagName(locale, tag)}
                      </Link>{' '}
                    </span>
                  ))}
                </td>
                <td>
                  {/* No badge at all without a verdict: `pend`'s "." glyph
                      means "still grading" on the submit screen, and a
                      problem never attempted is not pending anything. */}
                  {p.me?.verdict ? (
                    // The CODE stays a code; the localized long name rides
                    // in `title` for anyone who does not know it by heart.
                    <span
                      className={`badge ${verdictToken(p.me.verdict)}`}
                      title={verdictName(t, p.me.verdict)}
                    >
                      {p.me.verdict}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !query.isLoading && !query.isError ? (
        // A live region: the list re-runs as the reader types in the search
        // box, so a query that filters everything away must be announced
        // rather than silently swapping the table for this line. (loop-b20)
        <p role="status">{t('problems.empty')}</p>
      ) : null}

      {query.hasNextPage ? (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {t('common.loadMore')}
        </button>
      ) : null}
    </section>
  );
}

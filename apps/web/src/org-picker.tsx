/**
 * The organizations a setter may restrict a contest to (D56).
 *
 * Lives beside `me.ts` rather than in either contest form, because both forms
 * need exactly this control and a copy in each is a copy that drifts — the
 * create screen and the edit screen offering different organizations is the
 * bug this file exists to make impossible.
 *
 * **Which organizations are offered.** `GET /orgs` serves every organization
 * the caller can see, and `myRole` says where they stand in each; the API
 * accepts only the ones they OWN or ADMINISTER, so offering the rest would be
 * offering a 400. A global admin may attach any of them, and gets the whole
 * list — the same asymmetry every other permission in this app has.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { apiError } from './api-error.js';
import { meQueryOptions } from './me.js';
import { useT } from './i18n/index.js';

interface PickableOrg {
  slug: string;
  name: string;
  myRole: 'owner' | 'admin' | 'member' | null;
}

/**
 * How many pages of 100 this control will walk before it gives up.
 *
 * Not a page size and not a product limit: a stop so that a `nextCursor` the
 * server never stops issuing — a bug, a proxy replaying a response — cannot
 * spin this loop forever on a setter's contest form. Fifty thousand schools
 * is two orders of magnitude past a province.
 */
const PICKER_MAX_PAGES = 500;

/**
 * **The whole list, walked (D180).** This used to ask for one page of 100 and
 * stop, with a comment calling that deliberate: "a setter who owns more than
 * a hundred organizations has a different problem than a missing next
 * button". The comment was answering the wrong question. The page is not
 * "organizations the setter owns" — it is EVERY organization visible to them,
 * their own included, and `mine` is computed from it below. So a setter who
 * owns exactly one school still loses it the moment the judge's 101st
 * organization sorts ahead of it, and the control gives no sign: there is no
 * scroll position, no empty state and no button, only a checkbox that is not
 * there.
 *
 * A "load more" button — the fix the other five surfaces got — would be the
 * wrong shape here. A form control has to offer the whole option set at the
 * moment it is read; an option behind a press the setter has no reason to
 * make is an option they cannot apply. So the cursor is walked to exhaustion
 * inside the query, bounded by `PICKER_MAX_PAGES`.
 *
 * A stored slug the list does not contain is still rendered (see
 * `OrgPicker`), so nothing silently drops even if the walk is capped.
 */
export const orgsQueryOptions = {
  queryKey: ['orgs', 'picker'] as const,
  queryFn: async (): Promise<PickableOrg[]> => {
    const all: PickableOrg[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PICKER_MAX_PAGES; page += 1) {
      const query: { limit: number; cursor?: string } = { limit: 100 };
      if (cursor !== undefined) query.cursor = cursor;
      const result = await api.GET('/orgs', { params: { query } });
      // `throw`, never `?? []`. `openapi-fetch` resolves rather than rejects on
      // an HTTP error, so reading only `data` made every failure — a 500, an
      // expired session, a proxy hiccup — indistinguishable from an empty
      // roster: `useQuery` saw no error, the picker's own error line could
      // never render, and what the setter read instead was `orgsNone`, "you do
      // not own or administer any organization". That is a false statement
      // about their own account on the one screen where believing it means
      // shipping a provincial contest with no restriction at all. `apiError`
      // also carries the status, so `retryTransientOnly` retries a 500 and
      // leaves a 403 alone. A failure on page four is still a failure: the
      // whole query rejects rather than returning three pages as if they were
      // the answer.
      if (result.error) throw apiError(result, 'orgs');
      all.push(...(result.data?.items ?? []));
      const next = result.data?.nextCursor ?? null;
      if (next === null) break;
      cursor = next;
    }
    return all;
  },
};

export function OrgPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const me = useQuery(meQueryOptions);
  const orgs = useQuery(orgsQueryOptions);
  const isGlobalAdmin = me.data?.globalRole === 'admin';
  const mine = (orgs.data ?? []).filter(
    (org) => isGlobalAdmin || org.myRole === 'owner' || org.myRole === 'admin',
  );
  // A slug already on the contest that this caller cannot pick — an admin
  // attached it — is still SHOWN and still ticked, so an edit that touches
  // the name cannot silently drop the restriction the school relies on.
  const attachedElsewhere = value.filter((slug) => !mine.some((org) => org.slug === slug));

  function toggle(slug: string, on: boolean): void {
    onChange(on ? [...new Set([...value, slug])] : value.filter((s) => s !== slug));
  }

  return (
    <fieldset>
      <legend>{t('contestNew.orgs')}</legend>
      <p className="muted">{t('contestNew.orgsHint')}</p>
      {orgs.isPending ? <p className="muted">{t('common.loading')}</p> : null}
      {/* `muted`, NOT `role="alert"`: this is one control on a form that has
          its own alert for the save, and a second live region competing with
          it makes "what went wrong" ambiguous to a screen reader and to
          `getByRole('alert')` alike. A picker that cannot list is a degraded
          control, not a failed page — the setter can still save the contest
          without restricting it. */}
      {orgs.error ? <p className="muted">{t('contestNew.orgsError')}</p> : null}
      {orgs.data && mine.length === 0 && attachedElsewhere.length === 0 ? (
        <p className="muted">{t('contestNew.orgsNone')}</p>
      ) : null}
      {mine.map((org) => (
        <label key={org.slug}>
          <input
            type="checkbox"
            checked={value.includes(org.slug)}
            onChange={(e) => toggle(org.slug, e.target.checked)}
          />{' '}
          {org.name}{' '}
        </label>
      ))}
      {attachedElsewhere.map((slug) => (
        <label key={slug}>
          <input type="checkbox" checked onChange={(e) => toggle(slug, e.target.checked)} /> {slug}{' '}
        </label>
      ))}
    </fieldset>
  );
}

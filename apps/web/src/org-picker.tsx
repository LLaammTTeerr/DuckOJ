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
import { meQueryOptions } from './me.js';
import { useT } from './i18n/index.js';

interface PickableOrg {
  slug: string;
  name: string;
  myRole: 'owner' | 'admin' | 'member' | null;
}

/**
 * One page of 100 is deliberate and not a paginator: this is a form control,
 * and a setter who owns more than a hundred organizations has a different
 * problem than a missing "next" button. A stored slug the list does not
 * contain is still rendered (see `OrgPicker`), so nothing silently drops.
 */
export const orgsQueryOptions = {
  queryKey: ['orgs', 'picker'] as const,
  queryFn: async (): Promise<PickableOrg[]> => {
    const { data } = await api.GET('/orgs', { params: { query: { limit: 100 } } });
    return data?.items ?? [];
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

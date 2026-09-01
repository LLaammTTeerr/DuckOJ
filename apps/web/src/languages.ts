import { api } from './api.js';

/**
 * `GET /languages`, as a shared query-options object.
 *
 * It exists because F-39 turned the language key from a constant into a set:
 * `cpp17` was for two weeks the only value `languageKey` ever took, so every
 * surface that had to render one just printed the key, and every surface that
 * had to act on one hard-coded a small map beside it. Five rows makes both
 * habits wrong — `cpp20` reads as a filename, not as "C++20", and a map that
 * has not heard of `python3` downloads a Python file as `.txt`.
 *
 * The table is tiny, public (`@Public` + `languages:read`), identical for
 * every viewer and changes only when a migration runs, so one cached entry
 * serves the whole session. `staleTime: Infinity` for exactly that reason:
 * refetching it on every window focus would be a request per focus for an
 * answer that cannot have changed.
 *
 * NOT filtered to active rows. A submission made against a language later
 * deactivated must still render its name, which is the reason the route
 * returns inactive rows flagged rather than hidden — see the `Language`
 * contract. Callers that are offering a CHOICE filter; callers that are
 * naming a past submission do not.
 */
export function fetchLanguages() {
  return api.GET('/languages').then(({ data }) => data?.items ?? []);
}

export const languagesQueryOptions = {
  queryKey: ['languages'] as const,
  queryFn: fetchLanguages,
  staleTime: Infinity,
};

/** One row's fields, as the surfaces below need them. */
export interface LanguageNaming {
  name: string;
  extension: string;
}

/**
 * A key → `{ name, extension }` lookup over whatever the query returned.
 *
 * Total by construction: an unknown key (a row deleted outright, or a
 * response that has not arrived) answers with the key itself as the name and
 * `txt` as the extension. Both are the honest fallback — the key IS what the
 * page used to print, and a source of unknown language is safest downloaded
 * as plain text.
 */
export function namingFor(
  languages: readonly { key: string; name: string; extension: string }[],
  key: string,
): LanguageNaming {
  const row = languages.find((lang) => lang.key === key);
  return { name: row?.name ?? key, extension: row?.extension ?? 'txt' };
}

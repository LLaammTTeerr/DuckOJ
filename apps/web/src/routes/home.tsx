/**
 * The landing page.
 *
 * Until now `/` rendered the submit form directly — a scaffold from Phase 1,
 * when submitting was the only thing the app could do and there was nowhere
 * else to go. That stopped being true the moment problems became browsable,
 * and it left the home page answering a question nobody asked: it offered to
 * grade a solution before showing what there was to solve.
 *
 * Deliberately thin. It links to what exists and claims nothing that does
 * not — no submission history (the API exposes `GET /submissions/:id` and no
 * list endpoint), no statistics, no activity feed. A landing page advertising
 * features the backend cannot serve is worse than a plain one.
 */
import { Link } from '@tanstack/react-router';
import { useT } from '../i18n/index.js';

/**
 * Structural, not imported from `@duckoj/contracts`. `apps/web` deliberately
 * depends on the generated SDK rather than the contracts package — contracts
 * pulls in zod and the OpenAPI generator, neither of which belongs in a
 * browser bundle. Naming only the two fields this page reads keeps that
 * boundary intact.
 */
interface Viewer {
  displayName: string;
  globalRole: string;
}

export function HomePage({ me }: { me: Viewer | null }) {
  const t = useT();
  const canAuthor = me?.globalRole === 'setter' || me?.globalRole === 'admin';

  return (
    <section>
      {/* The product name, not a translatable string. */}
      <h1>DuckOJ</h1>
      <p>{t('home.intro')}</p>

      <h2>{t('home.startHere')}</h2>
      <ul>
        <li>
          <Link to="/problems">{t('home.browseProblems')}</Link>
          {t('home.browseProblemsNote')}
        </li>
        <li>
          <a href="/api/v1/docs">{t('home.apiReference')}</a>
          {t('home.apiReferenceNote')}
        </li>
        {canAuthor ? (
          <li>
            {/* Three pieces rather than one string with markup in it: the
                role name is a `<code>` in the middle of a sentence whose two
                halves reorder between locales. */}
            <Link to="/problems/new">{t('home.createProblem')}</Link>
            {t('home.createProblemPrefix')}
            <code>{me?.globalRole}</code>
            {t('home.createProblemSuffix')}
          </li>
        ) : null}
      </ul>

      {me ? (
        <p>
          {t('home.signedInPrefix')}
          <strong>{me.displayName}</strong>
          {t('home.signedInMiddle')}
          <em>{t('common.submitSolution')}</em>
          {t('home.signedInSuffix')}
        </p>
      ) : (
        <>
          <h2>{t('home.signInHeading')}</h2>
          <p>{t('home.signInNote')}</p>
        </>
      )}
    </section>
  );
}

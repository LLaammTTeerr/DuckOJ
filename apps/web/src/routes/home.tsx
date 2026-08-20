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
  const canAuthor = me?.globalRole === 'setter' || me?.globalRole === 'admin';

  return (
    <section>
      <h1>DuckOJ</h1>
      <p>
        An online judge: read a problem, submit a solution, get it graded against the problem
        setter&rsquo;s tests in a sandbox.
      </p>

      <h2>Start here</h2>
      <ul>
        <li>
          <Link to="/problems">Browse problems</Link> — public problems are readable without an account.
        </li>
        <li>
          <a href="/api/v1/docs">API reference</a> — every route, with a request builder.
        </li>
        {canAuthor ? (
          <li>
            <Link to="/problems/new">Create a problem</Link> — you have the{' '}
            <code>{me?.globalRole}</code> role.
          </li>
        ) : null}
      </ul>

      {me ? (
        <p>
          Signed in as <strong>{me.displayName}</strong>. Pick a problem and use its{' '}
          <em>Submit a solution</em> link — submissions are graded against the revision that was
          published when you sent them.
        </p>
      ) : (
        <>
          <h2>Sign in</h2>
          <p>
            An account is needed to submit. Browsing public problems is not gated.
          </p>
        </>
      )}
    </section>
  );
}

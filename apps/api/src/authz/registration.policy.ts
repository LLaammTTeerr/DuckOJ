import { AppError } from '../common/app.error.js';
import type { Registration } from '../config/config.schema.js';
import type { Actor } from './actor.js';

/**
 * "May this caller create an account here?", written ONCE (D200).
 *
 * ## Why this exists at all
 *
 * D197 chose `affiliated` over `authenticated` for a reason it stated
 * plainly: registration is open — D26 **meters** it, it does not **gate** it
 * — and B-35 took 482 of 482 accounts in 576 requests and 1.5 seconds from
 * one ordinary session. That reasoning is right, and it points at the thing
 * underneath it. Checked against the live edge while F-56 ran:
 *
 * ```
 * POST /api/v1/auth/register     (no cookie, no token, no invitation)
 * → 201
 * ```
 *
 * There was **no registration policy in this system at all** — no setting in
 * `apps/api/src/config`, nothing in `.env.example`. Anyone on the internet
 * could hold an account on a province's school judge: submit, consume judge
 * time on a fleet sized for a province, and appear wherever accounts appear.
 * They could not read children's names (D197 saw to that), which is a
 * different property from not being there at all.
 *
 * A public judge wants open registration. **A school district almost
 * certainly does not** — its pupils arrive by D61's bulk roster import and
 * `org:import`, not by signing up. So this is a deployment policy
 * (`REGISTRATION`), and this module is the one place that reads it.
 *
 * ## Two rungs, and why not three
 *
 * `open` is today's behaviour byte for byte. `closed` is the default: the
 * endpoint answers 403 `registration_closed` to everyone who is not a global
 * admin, and accounts exist because an operator made them.
 *
 * The rung this deliberately does NOT ship is `invite`. It is not a rung, it
 * is a feature — a code to store, a route to mint and rotate it, a redemption
 * path that joins the new account to the right school, a revocation story —
 * and a half-built invitation mechanism is worse for a province than none.
 * The switch is a closed enum rather than a boolean precisely so that adding
 * it later is one enum member and one migration, with no contract break and
 * no deployment re-reading its `.env`. What `closed` costs in the meantime is
 * stated in D200: a school that wants pupils to enrol themselves must run
 * `open` and accept D26's meter, or import them.
 *
 * ## What `closed` does to D26's oracle, which is the prize
 *
 * D26 has answered a fake `201` for a taken address since 29 August so that
 * `POST /auth/register` cannot be used to test whether an account exists, and
 * recorded that the compromise is *narrowed, not closed*: after the fake 201
 * the account still does not exist, so a chained login or `GET /users/{u}`
 * tells the two outcomes apart at one extra request each.
 *
 * Under `closed` there is nothing left to narrow. The refusal is a function
 * of two facts — the rung this deployment is on, and who the caller is — and
 * of **nothing whatsoever about the request body**. Every anonymous caller
 * gets the identical 403 for every address, including addresses that have
 * never existed, and gets it *before* the address is looked at, so there is
 * no timing shadow either. That is D155's structural argument for its own 503
 * said again on the other endpoint: what D26 forbids is a response that
 * DIFFERS by account, and this one differs by deployment.
 *
 * The live `.env` sets no `REGISTRATION`, exactly as it sets no
 * `NAME_DISCLOSURE`, so `closed` is what this province runs.
 *
 * ## The one caller who is not refused
 *
 * A global admin. Minting an account is *speaking for the school*, which is
 * D61's own test for who may run a roster import (owner or global admin, and
 * deliberately not an organization `admin`); with no organization in the
 * request there is no owner to be, so `admin` is the whole of it. A
 * **setter** is deliberately excluded: a setter authors problems, and D197
 * admits them to `authority` because a fresh province has no organizations
 * yet — a different question from who may create people.
 *
 * The bypass keeps three paths working that a province cannot lose: D61's
 * bulk import and `org:import` never touch this endpoint at all (they mint
 * rows directly, as staff of a named school), D19's `bootstrap:admin` is a
 * CLI against `DATABASE_URL` rather than a route, and D155/D157's password
 * reset is about an account that already exists. What the bypass adds is the
 * one-off: an admin creating a single account for a teacher who arrived after
 * the spreadsheet did.
 *
 * `apps/api/test/registration-guard.spec.ts` (D201) is the D113-shaped source
 * scan that keeps every account-minting path on this policy or in an audited
 * census, and keeps the switch itself readable in exactly one module.
 */

/**
 * The rung in effect, fail-closed.
 *
 * `AuthController` holds a real `AppConfig`, but this mirrors `policyOf`
 * (D197) on D80's precedent: a caller that assembles the config by hand — a
 * spec, a script — must not get the permissive rung by accident. An absent
 * config reads as `closed`, which is the same answer an operator who sets
 * nothing gets and the same direction the deployment default leans.
 */
export function registrationOf(config?: { registration: Registration } | null): Registration {
  return config?.registration ?? 'closed';
}

/**
 * Whether this caller is creating the account as an operator rather than as
 * its subject.
 *
 * Two consequences hang off it, both in `AuthController.register`, and they
 * are separate from "may they register at all" on purpose:
 *
 *  - **The D26 meter is skipped.** What that meter bounds is the cost of an
 *    anonymous argon2id hash (30 per IP per hour). An admin seating a class
 *    one account at a time is not that caller, and a global admin who wanted
 *    to spend this server's CPU has `org:import` and its two thousand rows.
 *  - **A taken address is answered honestly** — `409 email_taken` instead of
 *    D26's fake 201. This narrows D26 in exactly one place and for exactly
 *    D61's reason: the caller is session-authenticated and is a global admin,
 *    so this is not the anonymous oracle D26 closed, and an operator who
 *    cannot be told "that address is already in use" is handed a phantom
 *    account and no way to find out.
 */
export function isTrustedRegistrar(actor: Actor | null): boolean {
  return actor !== null && actor.globalRole === 'admin';
}

/** Whether this caller may create an account on this deployment. */
export function mayRegister(policy: Registration, actor: Actor | null): boolean {
  return policy === 'open' || isTrustedRegistrar(actor);
}

/**
 * Refuse a caller the policy does not admit — **before the meter and before
 * the address is looked at**, which is the half a response body does not
 * carry.
 *
 * `403`, not `404`. The project's deny-by-default posture answers 404 for a
 * *read you may not see*, because the existence of the row is itself the
 * secret. Nothing is hidden here: whether this judge takes sign-ups is a
 * property of the deployment that its own front page has to state anyway, and
 * a 404 on `POST /auth/register` would tell a visitor the site has no
 * registration endpoint — which is false, and sends them to look for another
 * one. D145's rule is the one that applies: a failure is named by its status
 * and offers the next move, and `apps/web/src/routes/register.tsx` renders
 * exactly that in both languages.
 */
export function assertRegistrationOpen(policy: Registration, actor: Actor | null): void {
  if (mayRegister(policy, actor)) return;
  throw new AppError(
    403,
    'registration_closed',
    'This site does not take sign-ups. Ask your school for an account.',
  );
}

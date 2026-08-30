/**
 * A directory this pipeline cannot read at all.
 *
 * Deliberately distinct from a gate FAILURE: a failure is a finding about a
 * problem that loaded (a missing answer, a model solution that disagrees) and
 * belongs in `prepare-report.json`; a `PrepareError` means there is nothing to
 * report on yet — no layout was recognised, `problem.xml` does not parse, the
 * toolchain is absent. The CLI prints the two differently, and the library
 * gives a wrapper (`apps/mcp`) the same distinction for free.
 */
export class PrepareError extends Error {}

/** What `DmojDriver` needs from judge-agent — just enough to ensure a package before dispatch. */
export interface AgentClient {
  ensure(hash: string): Promise<void>;
}

export interface AgentClientOptions {
  agentOrigin: string;
  /**
   * Bounded so a hung agent cannot wedge the worker loop — Phase 1 learned
   * this failure mode twice already (a swallowed `apply` that renewed a
   * lease forever, and a `compose-up.sh` with no timeout that hung a
   * bring-up for ten minutes). Well under `Worker`'s 300s grading watchdog,
   * generous enough for a large archive materialise.
   */
  timeoutMs?: number;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** A small `fetch` wrapper around judge-agent's `POST /packages/ensure` (Task 10). */
export class HttpAgentClient implements AgentClient {
  constructor(private readonly options: AgentClientOptions) {}

  async ensure(hash: string): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const res = await fetchImpl(`${this.options.agentOrigin}/packages/ensure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash }),
      // judge-agent has no route that legitimately takes this long; a hang
      // here must surface as a rejection, not stall the dispatch forever.
      signal: AbortSignal.timeout(timeoutMs),
    });
    // judge-agent answers exactly 204 on success (Task 10) — 400 on a
    // malformed hash, 502 on a materialise failure. Either is a reason to
    // reject, not to guess at a body that may not exist.
    if (res.status !== 204) {
      throw new Error(`judge-agent ensure failed for package ${hash}: HTTP ${res.status}`);
    }
  }
}

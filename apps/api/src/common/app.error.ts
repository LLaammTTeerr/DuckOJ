export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly fields?: Record<string, string[]>,
    /**
     * Response headers this error carries — today only `Retry-After` on a
     * 429, which RFC 9110 defines as a header and nothing else: a client
     * (and every CLI and CI runner) looks for it there, not in a JSON body.
     * `ProblemFilter` is what actually writes them, so an error thrown
     * anywhere gets them without the throw site touching the response.
     */
    readonly headers?: Record<string, string>,
  ) {
    super(detail ?? code);
    this.name = 'AppError';
  }
}

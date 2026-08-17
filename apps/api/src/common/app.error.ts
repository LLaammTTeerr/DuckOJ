export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(detail ?? code);
    this.name = 'AppError';
  }
}

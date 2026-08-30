/**
 * Statement → PDF, behind a port (the `Mailer` pattern, D15).
 *
 * `TypstStatementRenderer` shells out to the configured binary with the
 * document on stdin and the PDF on stdout — no temp files, so two
 * concurrent renders cannot collide. `config.typstBin: null` means the
 * feature is off and the route answers 501; there is deliberately no
 * PATH-sniffing fallback (a deploy states whether it renders PDFs the same
 * way it states whether it sends mail).
 */
import { spawn } from 'node:child_process';
import { AppError } from '../common/app.error.js';
import { markdownToTypst } from './markdown-to-typst.js';

export const STATEMENT_RENDERER = Symbol('STATEMENT_RENDERER');

export interface StatementRenderer {
  /** The problem's statement as a PDF. Throws `AppError` when it cannot. */
  render(name: string, statementMarkdown: string): Promise<Buffer>;
  /**
   * An already-lowered typst document as a PDF (D48). The booklet assembles
   * several statements into ONE document — page numbering runs across the
   * whole thing, and merging separately-compiled PDFs would need a second
   * dependency to do it worse — so it needs a way in that is not
   * "one problem's Markdown".
   */
  renderDocument(document: string): Promise<Buffer>;
}

export const PDF_UNAVAILABLE = new AppError(
  501,
  'statement_pdf_unavailable',
  'This server is not configured to render statement PDFs.',
);

/** The `typstBin: null` renderer: an honest 501, never a broken spawn. */
export class NullStatementRenderer implements StatementRenderer {
  render(): Promise<Buffer> {
    return Promise.reject(PDF_UNAVAILABLE);
  }

  renderDocument(): Promise<Buffer> {
    return Promise.reject(PDF_UNAVAILABLE);
  }
}

/**
 * How long one `typst compile` may run before it is killed.
 *
 * Twenty seconds. A statement is AUTHOR-CONTROLLED input to a Turing-complete
 * typesetter — `#while true { }` is a legal document — so without a bound one
 * problem body parks a Node process' child forever, and D48's booklet route
 * lets an organiser reach it for a whole contest at once. The number is chosen
 * against the slowest thing this legitimately does: the booklet compiles every
 * problem in a contest into one document, and the real binary does the
 * fourteen-problem fixture in well under a second (`contest-booklet.spec.ts`
 * runs it on every local run). Twenty seconds is two orders of magnitude of
 * headroom for a province's largest booklet on a loaded host, and still
 * bounded.
 */
export const TYPST_TIMEOUT_MS = 20_000;

/**
 * How much stdout one compile may produce before it is killed.
 *
 * 32 MiB. The whole PDF is buffered in memory (no temp files, by design — see
 * the module comment), so an unbounded document is an unbounded allocation in
 * the API process, which is D53's lesson in a second place. The largest
 * booklet this project has produced is under 2 MiB; 32 MiB is far above any
 * honest document and far below a heap the API cannot survive.
 */
export const TYPST_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Overridable bounds. Tests inject small ones; production uses the constants. */
export interface TypstLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class TypstStatementRenderer implements StatementRenderer {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(
    private readonly typstBin: string,
    limits: TypstLimits = {},
  ) {
    this.timeoutMs = limits.timeoutMs ?? TYPST_TIMEOUT_MS;
    this.maxOutputBytes = limits.maxOutputBytes ?? TYPST_MAX_OUTPUT_BYTES;
  }

  render(name: string, statementMarkdown: string): Promise<Buffer> {
    return this.renderDocument(markdownToTypst(name, statementMarkdown));
  }

  renderDocument(document: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.typstBin, ['compile', '-', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // `detached` makes the child a process-group leader, which is the
        // only thing that makes the kill below complete. `child.kill()`
        // signals exactly the pid we hold; typst is one shell away from being
        // a process TREE, and a grandchild that outlives the request is a
        // process nobody is left holding a handle to. With a group we can
        // signal `-pid` and take the whole thing down at once.
        detached: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      /** Set the moment a bound fires, so `close` reports the bound rather than the signal. */
      let bound: string | null = null;
      let settled = false;

      /**
       * Kills the child's whole process group, never throwing.
       *
       * ESRCH is normal and expected: the group may already be gone by the
       * time a timer fires. A throw here would replace the intended 500 with
       * an unhandled one.
       */
      const killGroup = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already dead, or never started — the `close`/`error` handler answers.
        }
      };

      const timer = setTimeout(() => {
        bound = `timed out after ${String(this.timeoutMs)} ms`;
        killGroup();
      }, this.timeoutMs);
      // The bound must not itself be a reason the process cannot exit: this
      // timer holds the event loop open for its whole duration otherwise.
      timer.unref();

      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AppError(500, 'statement_pdf_failed', message));
      };

      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > this.maxOutputBytes) {
          // Refused WHILE it is being written, not after: the point is that
          // the oversized document is never assembled in this process.
          bound = `output exceeded ${String(this.maxOutputBytes)} bytes`;
          out.length = 0;
          killGroup();
          return;
        }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      // A killed child's stdin is a broken pipe, and an unhandled EPIPE on it
      // is an uncatchable process-level throw rather than this route's 500.
      child.stdin.on('error', () => undefined);
      child.on('error', (cause) => {
        fail(`Could not run typst: ${cause.message}`);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // A bound that fired is always the reason, never the SIGKILL it
        // caused: `code` is null and stderr is empty for a killed process, so
        // without this the operator is told "typst failed: " and nothing else.
        if (bound !== null) {
          fail(`typst ${bound}`);
          return;
        }
        if (code === 0) {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(out));
          return;
        }
        // First stderr line only: typst's errors reference the generated
        // document, and pages of it in a problem body help nobody.
        const detail = Buffer.concat(err).toString('utf8').split('\n')[0] ?? '';
        fail(`typst failed: ${detail}`);
      });
      child.stdin.end(document);
    });
  }
}

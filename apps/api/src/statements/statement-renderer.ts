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

export class TypstStatementRenderer implements StatementRenderer {
  constructor(private readonly typstBin: string) {}

  render(name: string, statementMarkdown: string): Promise<Buffer> {
    return this.renderDocument(markdownToTypst(name, statementMarkdown));
  }

  renderDocument(document: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.typstBin, ['compile', '-', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', (cause) => {
        reject(
          new AppError(500, 'statement_pdf_failed', `Could not run typst: ${cause.message}`),
        );
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(out));
          return;
        }
        // First stderr line only: typst's errors reference the generated
        // document, and pages of it in a problem body help nobody.
        const detail = Buffer.concat(err).toString('utf8').split('\n')[0] ?? '';
        reject(new AppError(500, 'statement_pdf_failed', `typst failed: ${detail}`));
      });
      child.stdin.end(document);
    });
  }
}

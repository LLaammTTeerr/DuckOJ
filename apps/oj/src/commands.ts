/**
 * The `oj` CLI's commands, written against two seams so every one of them
 * is testable without a server or a terminal:
 *
 * - `client` is the generated SDK client (or a test double of it) — the
 *   commands speak the same contract the web app does, so the CLI cannot
 *   drift from the API without the SDK's types saying so;
 * - `io.print`/`io.fail` instead of console/process.exit.
 *
 * `watch` takes a `sleep` for the same reason: a test that really waits
 * two seconds per poll is a test nobody runs.
 */
import type { createClient } from '@duckoj/sdk';

export type Client = ReturnType<typeof createClient>;

export interface Io {
  print: (line: string) => void;
  /** Prints and throws `CliError` — commands never exit the process. */
  fail: (message: string) => never;
}

export class CliError extends Error {}

/** `.cpp` files overwhelmingly mean the default toolchain; anything else is explicit. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  cpp: 'cpp17',
  cc: 'cpp17',
  cxx: 'cpp17',
};

export function inferLanguage(filename: string, explicit: string | undefined, io: Io): string {
  if (explicit !== undefined) return explicit;
  const extension = filename.includes('.') ? filename.split('.').at(-1)! : '';
  const inferred = LANGUAGE_BY_EXTENSION[extension];
  if (inferred === undefined) {
    io.fail(`cannot infer a language from "${filename}" — pass --language <key> (see: oj languages)`);
  }
  return inferred;
}

export async function whoami(client: Client, io: Io): Promise<void> {
  const { data, error } = await client.GET('/auth/me');
  if (error || !data) io.fail('not signed in — check your token (oj login --url ... --token ...)');
  io.print(`${data.username} (${data.globalRole})`);
}

export async function listProblems(client: Client, io: Io): Promise<void> {
  const { data, error } = await client.GET('/problems', {});
  if (error || !data) io.fail('could not list problems');
  for (const problem of data.items) {
    io.print(`${problem.code}\t${problem.name}`);
  }
}

/**
 * `oj problems show <code>` — one problem, with its samples as data (D94).
 *
 * The samples are the reason this command exists: `oj problems` lists codes
 * and names, and everything else about a problem is readable in a browser,
 * but a sample you can pipe into a program is not. They print as
 * `--- sample N input`/`output` fences rather than a table, because the
 * output of this command is read by a person about to copy two blocks into
 * two files, and a table would put a newline where the file has none.
 *
 * `samples` is read with `?? []`: the CLI is routinely a version ahead of the
 * DuckOJ it is pointed at (the web reads `problem.editorial ?? null` for the
 * same reason), and a missing key must print a problem without samples, not
 * crash on the one command that shows them.
 */
export async function showProblem(client: Client, io: Io, code: string): Promise<void> {
  const { data, error } = await client.GET('/problems/{code}', { params: { path: { code } } });
  if (error || !data) io.fail(`could not read problem ${code}`);
  io.print(`${data.code}\t${data.name}`);
  io.print(
    `limits: ${data.timeMs === null ? '—' : `${String(data.timeMs)} ms`}, ` +
      `${data.memoryKb === null ? '—' : `${String(data.memoryKb)} KB`}` +
      (data.totalPoints === null ? '' : ` · ${String(data.totalPoints)} points`),
  );
  const samples = data.samples ?? [];
  if (samples.length === 0) {
    io.print('no samples (read the statement on the web, or ask for the PDF)');
    return;
  }
  for (const [i, sample] of samples.entries()) {
    const n = String(i + 1);
    io.print(`--- sample ${n} input${sample.truncated ? ' (truncated)' : ''}`);
    // The file's own bytes, with the one trailing newline the print adds
    // removed first: `io.print` is a line writer, and a sample file that ends
    // in a newline would otherwise gain a blank line it does not have.
    io.print(sample.input.replace(/\n$/, ''));
    io.print(`--- sample ${n} output`);
    io.print(sample.output.replace(/\n$/, ''));
    if (sample.explanation !== null) io.print(`--- sample ${n} note: ${sample.explanation}`);
  }
}

export async function listLanguages(client: Client, io: Io): Promise<void> {
  const { data, error } = await client.GET('/languages');
  if (error || !data) io.fail('could not list languages');
  for (const language of data.items) {
    io.print(`${language.key}\t${language.name}`);
  }
}

export async function submit(
  client: Client,
  io: Io,
  args: { problemCode: string; source: string; languageKey: string; contestKey?: string },
): Promise<number> {
  const { data, error, response } = await client.POST('/submissions', {
    body: {
      problemCode: args.problemCode,
      languageKey: args.languageKey,
      source: args.source,
      ...(args.contestKey !== undefined ? { contestKey: args.contestKey } : {}),
    },
  });
  if (error || !data) {
    // D80's meter gets the number, not just the sentence. This is the one
    // refusal a contestant meets from a script that is otherwise working —
    // "submission refused" with no wait tells somebody driving `oj` in a loop
    // nothing about how to stop being refused, and the seconds are the whole
    // answer. `Retry-After` is whole seconds (RFC 9110).
    if (error?.code === 'submission_rate_limited') {
      const retryAfter = response.headers.get('Retry-After');
      const seconds = Number(retryAfter);
      const wait = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
      io.fail(
        `submission refused: submitting too quickly (one every 10s, twenty every 10 min)` +
          (wait === null ? '' : ` — try again in ${String(wait)}s`),
      );
    }
    io.fail(`submission refused: ${error?.detail ?? 'unknown error'}`);
  }
  io.print(`submitted #${String(data.id)}`);
  return data.id;
}

/**
 * How many polls in a row may fail before `watch` stops believing the
 * submission is still out there.
 *
 * Every failed poll used to be fatal, so a single dropped packet — a network
 * blip, the API rolling behind the reverse proxy, one 502 from Caddy —
 * abandoned a submission that was grading perfectly well, and blamed the
 * submission while doing it. A watch is a long-lived contest-day loop; the
 * one thing it must survive is the network being briefly worse than perfect.
 * Six consecutive failures at two seconds apart is twelve seconds of nothing
 * at all, which is a real outage rather than a blip.
 */
const TRANSIENT_TOLERANCE = 5;

/** Polls until the submission leaves the judging pipeline, then reports. */
export async function watch(
  client: Client,
  io: Io,
  id: number,
  sleep: (ms: number) => Promise<void>,
  attempts = 150,
): Promise<void> {
  let lastState = '';
  let consecutiveFailures = 0;
  for (let i = 0; i < attempts; i++) {
    // openapi-fetch RESOLVES an HTTP error into `{ error, response }` but
    // RETHROWS a transport failure, so both shapes have to be collected
    // before either can be judged transient.
    let data: Awaited<ReturnType<Client['GET']>>['data'];
    let status: number | undefined;
    let ok = false;
    try {
      const result = await client.GET('/submissions/{id}', { params: { path: { id } } });
      data = result.data;
      status = result.response?.status;
      ok = !result.error && result.data !== undefined;
    } catch {
      ok = false;
    }

    if (!ok) {
      // A refused credential and a submission that does not exist are both
      // final answers. Retrying either five times only delays the message,
      // and "could not read submission #7" describes neither of them.
      if (status === 401 || status === 403) {
        io.fail(
          `your token was refused (HTTP ${String(status)}) — it may have expired; ` +
            'run: oj login --url <baseUrl> --token <token>',
        );
      }
      if (status === 404) io.fail(`could not read submission #${String(id)} — no such submission`);
      consecutiveFailures++;
      if (consecutiveFailures > TRANSIENT_TOLERANCE) {
        io.fail(
          `could not read submission #${String(id)} — ` +
            `${String(consecutiveFailures)} consecutive failed polls`,
        );
      }
      await sleep(2000);
      continue;
    }
    consecutiveFailures = 0;
    const detail = data!;
    if (detail.state !== lastState) {
      lastState = detail.state;
      io.print(detail.state);
    }
    if (detail.state === 'done' || detail.state === 'errored') {
      const points =
        detail.points === null || detail.maxPoints === null
          ? ''
          : ` ${String(detail.points)}/${String(detail.maxPoints)}`;
      io.print(`${detail.verdict ?? detail.state}${points}`);
      // The compiler's own words, whenever the judge had any. On a `CE` this
      // is the entire content of the verdict — without it the CLI said `CE`
      // and stopped, leaving a caller to re-fetch the submission by hand to
      // learn what was wrong — and on any other verdict it is the compile
      // WARNING, which lands in the same field on a submission that graded.
      if (detail.compileOutput) io.print(detail.compileOutput);
      return;
    }
    await sleep(2000);
  }
  io.fail(`gave up after ${String(attempts)} polls — the submission is still in the queue`);
}

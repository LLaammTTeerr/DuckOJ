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
  const { data, error } = await client.POST('/submissions', {
    body: {
      problemCode: args.problemCode,
      languageKey: args.languageKey,
      source: args.source,
      ...(args.contestKey !== undefined ? { contestKey: args.contestKey } : {}),
    },
  });
  if (error || !data) {
    io.fail(`submission refused: ${error?.detail ?? 'unknown error'}`);
  }
  io.print(`submitted #${String(data.id)}`);
  return data.id;
}

/** Polls until the submission leaves the judging pipeline, then reports. */
export async function watch(
  client: Client,
  io: Io,
  id: number,
  sleep: (ms: number) => Promise<void>,
  attempts = 150,
): Promise<void> {
  let lastState = '';
  for (let i = 0; i < attempts; i++) {
    const { data, error } = await client.GET('/submissions/{id}', {
      params: { path: { id } },
    });
    if (error || !data) io.fail(`could not read submission #${String(id)}`);
    if (data.state !== lastState) {
      lastState = data.state;
      io.print(data.state);
    }
    if (data.state === 'done' || data.state === 'errored') {
      const points =
        data.points === null || data.maxPoints === null
          ? ''
          : ` ${String(data.points)}/${String(data.maxPoints)}`;
      io.print(`${data.verdict ?? data.state}${points}`);
      return;
    }
    await sleep(2000);
  }
  io.fail(`gave up after ${String(attempts)} polls — the submission is still in the queue`);
}

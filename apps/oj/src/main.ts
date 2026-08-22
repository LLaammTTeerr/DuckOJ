#!/usr/bin/env node
/**
 * Argument dispatch only — every command lives in commands.ts behind the
 * `client`/`io` seams, and this file is the one place that touches
 * process.argv, process.exit and the real clock.
 */
import { readFile } from 'node:fs/promises';
import { createClient } from '@duckoj/sdk';
import { CliError, inferLanguage, listLanguages, listProblems, submit, watch, whoami, type Io } from './commands.js';
import { configPath, loadConfig, saveConfig } from './config.js';

const USAGE = `usage:
  oj login --url <baseUrl> --token <accessToken>
  oj whoami
  oj problems
  oj languages
  oj submit <problemCode> <file> [--language <key>] [--contest <key>] [--watch]
  oj watch <submissionId>`;

const io: Io = {
  print: (line) => console.log(line),
  fail: (message) => {
    throw new CliError(message);
  },
};

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined) throw new CliError(`--${name} needs a value`);
  return value;
}

async function requireClient() {
  const config = await loadConfig();
  if (!config) {
    throw new CliError(`no credentials — run: oj login --url <baseUrl> --token <token>\n(config: ${configPath()})`);
  }
  return createClient({ baseUrl: config.baseUrl, token: config.token });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'login': {
      const baseUrl = flag(rest, 'url');
      const token = flag(rest, 'token');
      if (!baseUrl || !token) throw new CliError(USAGE);
      await saveConfig({ baseUrl, token });
      console.log(`saved ${configPath()}`);
      return;
    }
    case 'whoami':
      return whoami(await requireClient(), io);
    case 'problems':
      return listProblems(await requireClient(), io);
    case 'languages':
      return listLanguages(await requireClient(), io);
    case 'submit': {
      const [problemCode, file] = rest.filter((a) => !a.startsWith('--'));
      if (!problemCode || !file) throw new CliError(USAGE);
      const source = await readFile(file, 'utf8');
      const languageKey = inferLanguage(file, flag(rest, 'language'), io);
      const client = await requireClient();
      const contestKey = flag(rest, 'contest');
      const id = await submit(client, io, {
        problemCode,
        source,
        languageKey,
        ...(contestKey !== undefined ? { contestKey } : {}),
      });
      if (rest.includes('--watch')) await watch(client, io, id, sleep);
      return;
    }
    case 'watch': {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new CliError(USAGE);
      return watch(await requireClient(), io, id, sleep);
    }
    default:
      throw new CliError(USAGE);
  }
}

try {
  await run(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

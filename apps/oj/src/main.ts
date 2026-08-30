#!/usr/bin/env node
/**
 * Argument dispatch only — every command lives in commands.ts behind the
 * `client`/`io` seams, and this file is the one place that touches
 * process.argv, process.exit and the real clock.
 */
import { readFile } from 'node:fs/promises';
import { createClient } from '@duckoj/sdk';
import { parseArgs } from './args.js';
import { CliError, inferLanguage, listLanguages, listProblems, submit, watch, whoami, type Io } from './commands.js';
import { configPath, loadConfig, saveConfig } from './config.js';

const USAGE = `usage:
  oj login --url <baseUrl> --token <accessToken>
  oj whoami
  oj problems
  oj languages
  oj submit <problemCode> <file> [--language <key>] [--contest <key>] [--watch]
  oj watch <submissionId>
  oj mcp                (Model Context Protocol server on stdio; DUCKOJ_MCP_WRITES=1 for write tools)`;

const io: Io = {
  print: (line) => console.log(line),
  fail: (message) => {
    throw new CliError(message);
  },
};

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
  if (command === undefined) throw new CliError(USAGE);
  // Parsed once, by a splitter that knows which options take a value — see
  // `args.ts` for the bug that motivated it.
  const args = parseArgs(rest);
  switch (command) {
    case 'login': {
      const baseUrl = args.flags['url'];
      const token = args.flags['token'];
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
      const [problemCode, file] = args.positionals;
      if (!problemCode || !file) throw new CliError(USAGE);
      const source = await readFile(file, 'utf8');
      const languageKey = inferLanguage(file, args.flags['language'], io);
      const client = await requireClient();
      const contestKey = args.flags['contest'];
      const id = await submit(client, io, {
        problemCode,
        source,
        languageKey,
        ...(contestKey !== undefined ? { contestKey } : {}),
      });
      if (args.switches.has('watch')) await watch(client, io, id, sleep);
      return;
    }
    case 'mcp': {
      // The saved credential, handed to the MCP server — the whole point of
      // the subcommand is that somebody who has run `oj login` does not
      // manage a second copy of their token in a host's config file.
      //
      // Imported dynamically, not at the top: `@duckoj/mcp` pulls in the MCP
      // SDK, and every other `oj` subcommand would pay that startup cost to
      // reach code it never runs.
      //
      // NOTHING here may print to stdout — the stdio transport owns it from
      // the moment the server connects, and one stray line desyncs the
      // host's JSON-RPC parser. The banner is the server's own, on stderr.
      const config = await loadConfig();
      if (!config) {
        throw new CliError(`no credentials — run: oj login --url <baseUrl> --token <token>\n(config: ${configPath()})`);
      }
      const { normalizeBaseUrl, runMcpServer, writesEnabled } = await import('@duckoj/mcp');
      await runMcpServer({
        baseUrl: normalizeBaseUrl(config.baseUrl),
        token: config.token,
        writes: writesEnabled(),
      });
      // Deliberately no `return` into process exit: the transport keeps the
      // event loop alive for as long as the host holds stdin open.
      return;
    }
    case 'watch': {
      const id = Number(args.positionals[0]);
      // `> 0`, not merely an integer: `Number('')` is 0, so `oj watch ''`
      // otherwise asked the API for submission #0.
      if (!Number.isInteger(id) || id <= 0) throw new CliError(USAGE);
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

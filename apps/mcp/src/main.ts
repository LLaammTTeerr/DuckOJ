#!/usr/bin/env node
/**
 * The stdio entrypoint. Credential discovery and process exit only —
 * everything else is behind `runMcpServer`, so nothing that matters lives in
 * a file no test can import.
 *
 * A refusal goes to stderr and exits 1: an MCP host shows the server's stderr
 * when a server fails to start, and "no DuckOJ credential" there is the
 * difference between a five-second fix and a silent, permanently red server.
 */
import { ConfigError, resolveConfig } from './config.js';
import { runMcpServer } from './run.js';

try {
  const config = await resolveConfig();
  await runMcpServer({ baseUrl: config.baseUrl, token: config.token, writes: config.writes });
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  }
  throw err;
}

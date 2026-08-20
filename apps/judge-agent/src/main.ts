import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { describeError } from '@duckoj/observability';
import { loadConfig } from './config.js';
import { Materializer, PACKAGE_HASH_PATTERN } from './materializer.js';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
}

function isEnsureBody(value: unknown): value is { hash: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { hash?: unknown }).hash === 'string'
  );
}

async function handleEnsure(
  req: IncomingMessage,
  res: ServerResponse,
  materializer: Materializer,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!isEnsureBody(body) || !PACKAGE_HASH_PATTERN.test(body.hash)) {
    res.writeHead(400).end();
    return;
  }

  try {
    await materializer.ensure(body.hash);
    res.writeHead(204).end();
  } catch (error) {
    // describeError deliberately withholds `.message` — the only thing this
    // agent ever throws that could carry an operator-relevant detail beyond
    // that is a package hash, which is not sensitive. It never carries the
    // judge token: the token is only ever placed in the outgoing
    // `Authorization` header, never interpolated into an Error.
    console.error(
      JSON.stringify({ msg: 'materialise failed', hash: body.hash, error: describeError(error) }),
    );
    res.writeHead(502).end();
  }
}

/** A plain two-route internal service — no Nest, as in apps/judged's health server. */
export function createAgentServer(materializer: Materializer): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/packages/ensure') {
      void handleEnsure(req, res, materializer);
      return;
    }
    res.writeHead(404).end();
  });
  // Without a listener, a startup failure (e.g. EADDRINUSE) surfaces as an
  // uncaught 'error' with a raw stack instead of through main().catch's
  // one-line message. Attached before listen() so it can never miss the
  // failure it exists to catch.
  server.on('error', (error) => {
    console.error(JSON.stringify({ msg: 'judge-agent server error', error: describeError(error) }));
  });
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const materializer = new Materializer({
    apiOrigin: config.apiOrigin,
    judgeName: config.judgeName,
    judgeToken: config.judgeToken,
    problemsDir: config.problemsDir,
  });

  const server = createAgentServer(materializer);
  server.listen(config.agentPort, '0.0.0.0');
  console.log(JSON.stringify({ msg: 'judge-agent listening', port: config.agentPort }));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ msg: 'judge-agent failed to start', error: describeError(error) }),
  );
  process.exit(1);
});

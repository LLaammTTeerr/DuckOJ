import { createServer, type Server } from 'node:http';

/** Liveness only — Compose needs something direct to probe. */
export function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404).end();
  });
  // Without a listener, a startup failure (e.g. EADDRINUSE) surfaces as an
  // uncaught 'error' with a raw stack instead of through main().catch's
  // one-line message.
  server.on('error', (error) => {
    console.error(JSON.stringify({ msg: 'health server error', error: error.message }));
  });
  server.listen(port, '0.0.0.0');
  return server;
}

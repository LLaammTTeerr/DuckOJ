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
  server.listen(port, '0.0.0.0');
  return server;
}

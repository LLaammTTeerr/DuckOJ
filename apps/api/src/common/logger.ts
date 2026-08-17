import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';

export function requestLogger(level: string) {
  return pinoHttp({
    level,
    genReqId: (req, res) => {
      const existing = req.headers['x-request-id'];
      const id = typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  });
}

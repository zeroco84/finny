import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/**
 * Machine-to-machine auth for the BlockDocs pull endpoint — a static bearer
 * token, timing-safe-compared like the session signature in auth.ts. Not a
 * human session: BlockDocs' sync job polls with this token on a schedule.
 */
export function requireBlockDocsToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.blockdocsToken) {
    res.status(503).json({ error: 'BlockDocs integration is not configured' });
    return;
  }
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = config.blockdocsToken;
  const ok =
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    res.status(401).json({ error: 'Invalid or missing bearer token' });
    return;
  }
  next();
}

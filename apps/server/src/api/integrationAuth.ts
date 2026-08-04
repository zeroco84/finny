import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/**
 * Machine-to-machine auth for the BlockDocs pull endpoint — a static bearer
 * token, timing-safe-compared like the session signature in auth.ts. Not a
 * human session: BlockDocs' sync job polls with this token on a schedule.
 */
export function requireBlockDocsToken(req: Request, res: Response, next: NextFunction): void {
  requireStaticToken(req, res, next, config.blockdocsToken, 'BlockDocs integration');
}

/**
 * Auth for the Power Automate approval-decision callback. Same shape: the flow
 * is a machine caller, not a human session. Unset token = endpoint closed (503),
 * never open — a decision callback flips an invoice to approved, so it must
 * fail shut.
 */
export function requireApprovalCallbackToken(req: Request, res: Response, next: NextFunction): void {
  requireStaticToken(req, res, next, config.approvalsCallbackToken, 'Approval callback');
}

function requireStaticToken(
  req: Request,
  res: Response,
  next: NextFunction,
  expected: string,
  label: string,
): void {
  if (!expected) {
    res.status(503).json({ error: `${label} is not configured` });
    return;
  }
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const ok =
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    res.status(401).json({ error: 'Invalid or missing bearer token' });
    return;
  }
  next();
}

import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

const REQUEST_ID_HEADER = 'X-Request-Id';

/** Reuses an inbound X-Request-Id when present, otherwise mints a new UUID. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && incoming.length <= 128 ? incoming : uuidv4();
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

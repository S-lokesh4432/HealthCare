import { NextFunction, Request, Response } from 'express';
import { Role } from '@prisma/client';
import { verifyToken, TokenPayload } from '../lib/jwt';
import { forbidden, unauthorized } from '../lib/errors';

declare global {
  namespace Express {
    interface Request {
      auth?: TokenPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());

  const payload = verifyToken(header.slice(7).trim());
  if (!payload) return next(unauthorized('Invalid or expired token'));

  req.auth = payload;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden());
    next();
  };
}

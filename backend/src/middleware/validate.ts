import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { ApiError } from '../lib/errors';

function describe(issues: { path: (string | number)[]; message: string }[], fallback: string) {
  return issues.map((i) => `${i.path.join('.') || fallback}: ${i.message}`).join('; ');
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new ApiError(400, describe(result.error.issues, 'body'), 'VALIDATION_ERROR'));
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(new ApiError(400, describe(result.error.issues, 'query'), 'VALIDATION_ERROR'));
    }
    res.locals.query = result.data;
    next();
  };
}

export function query<T>(res: Response): T {
  return res.locals.query as T;
}

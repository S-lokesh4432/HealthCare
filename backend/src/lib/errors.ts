import { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
  }
}

export const badRequest = (m: string, code?: string) => new ApiError(400, m, code);
export const unauthorized = (m = 'Authentication required') => new ApiError(401, m);
export const forbidden = (m = 'You do not have access to this resource') => new ApiError(403, m);
export const notFound = (m = 'Not found') => new ApiError(404, m);
export const conflict = (m: string, code?: string) => new ApiError(409, m, code);

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export const asyncHandler =
  (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);

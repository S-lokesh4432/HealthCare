import jwt, { SignOptions } from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from './env';

export interface TokenPayload {
  userId: string;
  role: Role;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as SignOptions);
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { userId, role } = decoded as Record<string, unknown>;
    if (typeof userId !== 'string' || typeof role !== 'string') return null;
    if (!Object.values(Role).includes(role as Role)) return null;
    return { userId, role: role as Role };
  } catch {
    return null;
  }
}

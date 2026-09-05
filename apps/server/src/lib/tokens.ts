import { randomBytes, randomUUID } from 'node:crypto';

import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';

import { config } from '../config';

const JWT_ALG = 'HS256';
const JWT_ISSUER = 'streaming-backbone';
const JWT_AUDIENCE = 'streaming-admin';

/** Access tokens are short-lived; the refresh token is what carries a session. */
export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const secretKey = new TextEncoder().encode(config.JWT_SECRET);

export type AdminRole = 'ADMIN' | 'VIEWER';

/** Claims carried by an admin access token. */
export interface AdminTokenPayload {
  adminUserId: string;
  email: string;
  role: AdminRole;
}

export async function signAccessToken(payload: AdminTokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email, role: payload.role })
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(payload.adminUserId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(secretKey);
}

/** Resolves to the claims, or null when the token is absent/expired/forged. */
export async function verifyAccessToken(token: string): Promise<AdminTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: [JWT_ALG],
    });

    const { sub, email, role } = payload;
    if (typeof sub !== 'string' || typeof email !== 'string') return null;
    if (role !== 'ADMIN' && role !== 'VIEWER') return null;

    return { adminUserId: sub, email, role };
  } catch {
    // Any verification failure is an unauthenticated request — never log the token.
    return null;
  }
}

/**
 * A refresh token is `<rowId>.<secret>`.
 *
 * argon2 hashes are salted, so a stored hash cannot be looked up directly. The
 * row id acts as the selector for a single indexed read, and only the secret
 * half is hashed and compared — no table scan, no hashing every live session.
 */
export interface GeneratedRefreshToken {
  id: string;
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export async function generateRefreshToken(): Promise<GeneratedRefreshToken> {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');

  return {
    id,
    token: `${id}.${secret}`,
    tokenHash: await argon2.hash(secret),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Splits a presented refresh token, returning null when it is malformed.
 *
 * The id half is UUID-checked here rather than at the query: Postgres raises on
 * a bad uuid cast, which would turn a garbage token into a 500 instead of a 401.
 */
export function parseRefreshToken(token: string): { id: string; secret: string } | null {
  const separator = token.indexOf('.');
  if (separator <= 0) return null;

  const id = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!secret || !UUID_PATTERN.test(id)) return null;

  return { id, secret };
}

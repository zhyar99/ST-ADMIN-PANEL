import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { adminAuth } from '../../middleware/adminAuth';
import { authLimiter } from '../../middleware/rateLimit';
import { adminRefreshToken, adminUser } from '../../db/schema';
import { db } from '../../db/client';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  generateRefreshToken,
  parseRefreshToken,
  signAccessToken,
  type AdminRole,
} from '../../lib/tokens';

export const adminAuthRouter: Router = Router();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(500),
});

/** Same message for unknown email, wrong password and disabled account. */
const INVALID_CREDENTIALS = new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

async function issueSession(user: {
  id: string;
  email: string;
  role: AdminRole;
}): Promise<SessionTokens> {
  const refresh = await generateRefreshToken();

  await db.insert(adminRefreshToken).values({
    id: refresh.id,
    adminUserId: user.id,
    tokenHash: refresh.tokenHash,
    expiresAt: refresh.expiresAt,
  });

  const accessToken = await signAccessToken({
    adminUserId: user.id,
    email: user.email,
    role: user.role,
  });

  return { accessToken, refreshToken: refresh.token };
}

/**
 * Looks up the refresh token row behind a presented token and verifies its
 * secret half. Returns null for anything unusable — malformed, unknown,
 * revoked, expired, wrong secret, or owned by a deactivated account.
 */
async function resolveRefreshToken(presented: string) {
  const parsed = parseRefreshToken(presented);
  if (!parsed) return null;

  const [row] = await db
    .select()
    .from(adminRefreshToken)
    .where(eq(adminRefreshToken.id, parsed.id))
    .limit(1);

  if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) return null;
  if (!(await argon2.verify(row.tokenHash, parsed.secret))) return null;

  const [user] = await db
    .select()
    .from(adminUser)
    .where(eq(adminUser.id, row.adminUserId))
    .limit(1);

  if (!user || !user.isActive) return null;

  return { row, user };
}

adminAuthRouter.post('/login', authLimiter, async (req: Request, res: Response) => {
  const { email, password } = parseOrThrow(loginSchema, req.body ?? {});

  const [user] = await db.select().from(adminUser).where(eq(adminUser.email, email)).limit(1);

  if (!user) {
    // Hash anyway so a missing account and a wrong password take the same time.
    await argon2.hash(password);
    throw INVALID_CREDENTIALS;
  }

  if (!(await argon2.verify(user.passwordHash, password)) || !user.isActive) {
    throw INVALID_CREDENTIALS;
  }

  const tokens = await issueSession({ id: user.id, email: user.email, role: user.role });

  await db
    .update(adminUser)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(adminUser.id, user.id));

  await recordAudit({
    adminUserId: user.id,
    action: 'LOGIN',
    entityType: 'admin_user',
    entityId: user.id,
  });

  res.json({
    ...tokens,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// Deliberately not behind `authLimiter`: every page load spends one refresh,
// so a 10-per-15-minutes budget would lock an active admin out of their own
// session. Refresh tokens are 256 bits of randomness — not brute-forceable —
// and the general /api/v1 limiter still applies.
adminAuthRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = parseOrThrow(refreshSchema, req.body ?? {});

  const resolved = await resolveRefreshToken(refreshToken);
  if (!resolved) {
    throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  }

  // Rotate: the presented token is spent even though the session continues.
  await db
    .update(adminRefreshToken)
    .set({ revokedAt: new Date() })
    .where(eq(adminRefreshToken.id, resolved.row.id));

  const tokens = await issueSession({
    id: resolved.user.id,
    email: resolved.user.email,
    role: resolved.user.role,
  });

  res.json(tokens);
});

adminAuthRouter.post('/logout', adminAuth, async (req: Request, res: Response) => {
  const { refreshToken } = parseOrThrow(refreshSchema, req.body ?? {});
  const parsed = parseRefreshToken(refreshToken);

  if (parsed && req.admin) {
    // Scoped to the caller so one session cannot revoke another account's.
    await db
      .update(adminRefreshToken)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(adminRefreshToken.id, parsed.id),
          eq(adminRefreshToken.adminUserId, req.admin.adminUserId),
          isNull(adminRefreshToken.revokedAt),
        ),
      );

    await recordAudit({
      adminUserId: req.admin.adminUserId,
      action: 'LOGOUT',
      entityType: 'admin_user',
      entityId: req.admin.adminUserId,
    });
  }

  res.status(204).end();
});

adminAuthRouter.get('/me', adminAuth, async (req: Request, res: Response) => {
  const adminUserId = req.admin?.adminUserId;
  if (!adminUserId) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');

  const [user] = await db
    .select({
      id: adminUser.id,
      email: adminUser.email,
      name: adminUser.name,
      role: adminUser.role,
      isActive: adminUser.isActive,
      lastLoginAt: adminUser.lastLoginAt,
    })
    .from(adminUser)
    .where(eq(adminUser.id, adminUserId))
    .limit(1);

  // The token can outlive the account it names.
  if (!user || !user.isActive) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Account is no longer active');
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
  });
});

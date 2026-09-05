import argon2 from 'argon2';
import { and, eq, ne, sql } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { adminAuth } from '../../middleware/adminAuth';
import { requireRole } from '../../middleware/rbac';
import { adminUser } from '../../db/schema';
import { db } from '../../db/client';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';

export const adminUsersRouter: Router = Router();

// Managing staff accounts is an ADMIN-only surface, top to bottom.
adminUsersRouter.use(adminAuth, requireRole('ADMIN'));

/** Column list shared by every response — password_hash is never selectable. */
const publicColumns = {
  id: adminUser.id,
  email: adminUser.email,
  name: adminUser.name,
  role: adminUser.role,
  isActive: adminUser.isActive,
  lastLoginAt: adminUser.lastLoginAt,
  createdAt: adminUser.createdAt,
};

const roleSchema = z.enum(['ADMIN', 'VIEWER']);

const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  role: roleSchema,
});

const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });

const idParamSchema = z.object({ id: z.string().uuid('Not a valid user id') });

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

/** Counts active ADMINs other than `exceptId`, to protect the last one. */
async function otherActiveAdminCount(exceptId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminUser)
    .where(and(eq(adminUser.role, 'ADMIN'), eq(adminUser.isActive, true), ne(adminUser.id, exceptId)));

  return row?.count ?? 0;
}

adminUsersRouter.get('/', async (_req: Request, res: Response) => {
  const users = await db.select(publicColumns).from(adminUser).orderBy(adminUser.createdAt);
  res.json({ users });
});

adminUsersRouter.post('/', async (req: Request, res: Response) => {
  const input = parseOrThrow(createUserSchema, req.body ?? {});

  const [existing] = await db
    .select({ id: adminUser.id })
    .from(adminUser)
    .where(eq(adminUser.email, input.email))
    .limit(1);

  if (existing) {
    throw new HttpError(409, 'EMAIL_TAKEN', 'An admin user with that email already exists');
  }

  const [created] = await db
    .insert(adminUser)
    .values({
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: await argon2.hash(input.password),
    })
    .returning(publicColumns);

  if (!created) throw new HttpError(500, 'INTERNAL_ERROR', 'Failed to create user');

  await recordAudit({
    adminUserId: callerId(req),
    action: 'USER_CREATE',
    entityType: 'admin_user',
    entityId: created.id,
  });

  res.status(201).json({ user: created });
});

adminUsersRouter.patch('/:id', async (req: Request, res: Response) => {
  const { id } = parseOrThrow(idParamSchema, req.params);
  const input = parseOrThrow(updateUserSchema, req.body ?? {});
  const actorId = callerId(req);

  const [target] = await db.select().from(adminUser).where(eq(adminUser.id, id)).limit(1);
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'Admin user not found');

  if (id === actorId && input.isActive === false) {
    throw new HttpError(409, 'SELF_DEACTIVATION', 'You cannot deactivate your own account');
  }

  // Losing the final active ADMIN would lock everyone out of user management.
  const losesAdmin =
    target.role === 'ADMIN' &&
    target.isActive &&
    (input.role === 'VIEWER' || input.isActive === false);

  if (losesAdmin && (await otherActiveAdminCount(id)) === 0) {
    throw new HttpError(409, 'LAST_ADMIN', 'The last active ADMIN cannot be demoted or deactivated');
  }

  const [updated] = await db
    .update(adminUser)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      updatedAt: new Date(),
    })
    .where(eq(adminUser.id, id))
    .returning(publicColumns);

  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Admin user not found');

  await recordAudit({
    adminUserId: actorId,
    action: 'USER_UPDATE',
    entityType: 'admin_user',
    entityId: id,
  });

  res.json({ user: updated });
});

adminUsersRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = parseOrThrow(idParamSchema, req.params);
  const actorId = callerId(req);

  const [target] = await db.select().from(adminUser).where(eq(adminUser.id, id)).limit(1);
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'Admin user not found');

  if (id === actorId) {
    throw new HttpError(409, 'SELF_DELETION', 'You cannot delete your own account');
  }

  if (target.isActive) {
    throw new HttpError(409, 'USER_ACTIVE', 'Deactivate the user before deleting it');
  }

  if (target.role === 'ADMIN' && (await otherActiveAdminCount(id)) === 0) {
    throw new HttpError(409, 'LAST_ADMIN', 'The last ADMIN account cannot be deleted');
  }

  // Sessions cascade away with the row (admin_refresh_token FK ON DELETE CASCADE).
  await db.delete(adminUser).where(eq(adminUser.id, id));

  await recordAudit({
    adminUserId: actorId,
    action: 'USER_DELETE',
    entityType: 'admin_user',
    entityId: id,
  });

  res.status(204).end();
});

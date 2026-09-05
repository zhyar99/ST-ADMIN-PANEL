import { Router, type Request, type Response } from 'express';

import { adminAuth } from '../../middleware/adminAuth';
import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import { genreBody, genreIdParam } from '../../schemas/catalogSchemas';
import {
  createGenre,
  deleteGenre,
  listGenres,
  updateGenre,
} from '../../services/content/genreService';

export const adminGenresRouter: Router = Router();

// Reading the genre list is needed by anyone editing a movie; changing the
// vocabulary itself is ADMIN-only and applied per-route below.
adminGenresRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

adminGenresRouter.get('/', async (_req: Request, res: Response) => {
  res.json({ genres: await listGenres() });
});

adminGenresRouter.post('/', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const input = parseOrThrow(genreBody, req.body ?? {});
  const created = await createGenre(input.name_i18n);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'GENRE_CREATE',
    entityType: 'genre',
    entityId: created.id,
  });

  res.status(201).json({ genre: created });
});

adminGenresRouter.patch('/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(genreIdParam, req.params);
  const input = parseOrThrow(genreBody, req.body ?? {});

  const updated = await updateGenre(id, input.name_i18n);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'GENRE_UPDATE',
    entityType: 'genre',
    entityId: id,
  });

  res.json({ genre: updated });
});

adminGenresRouter.delete('/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(genreIdParam, req.params);

  await deleteGenre(id);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'GENRE_DELETE',
    entityType: 'genre',
    entityId: id,
  });

  res.status(204).end();
});

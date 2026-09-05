import { Router, type Request, type Response } from 'express';

import { recordAudit } from '../../lib/audit';
import { pickLocale } from '../../lib/i18n';
import { parseOrThrow } from '../../lib/validate';
import { adminAuth } from '../../middleware/adminAuth';
import { HttpError } from '../../middleware/errorHandler';
import { requireRole } from '../../middleware/rbac';
import {
  contentLookupQuery,
  contentSearchQuery,
  homeRowCreateBody,
  homeRowIdParam,
  homeRowReorderBody,
  homeRowUpdateBody,
} from '../../schemas/homeSchemas';
import {
  createHomeRow,
  deleteHomeRow,
  listHomeRows,
  reorderHomeRows,
  requireHomeRow,
  updateHomeRow,
} from '../../repositories/homeRowRepository';
import { lookupContent, searchContent } from '../../services/home/contentSearchService';

/**
 * Home row curation.
 *
 * A VIEWER may read rows and use the item picker; every mutation is
 * ADMIN-gated, matching `adminLiveChannelsRouter`.
 *
 * Rows are returned with `item_refs` exactly as stored — no content resolution
 * — because the editor has to keep showing a ref whose target was unpublished.
 * Resolving here would make such an entry vanish from the UI, and the operator
 * would have no way to remove the thing they cannot see.
 */
export const adminHomeRouter: Router = Router();

adminHomeRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

/**
 * Item picker search. Read-only, so a VIEWER may call it.
 *
 * Declared before `/rows/:id` would ever be reached and on a separate path, so
 * there is no ambiguity either way.
 */
adminHomeRouter.get('/content-search', async (req: Request, res: Response) => {
  const { q, type, limit } = parseOrThrow(contentSearchQuery, req.query);

  res.json({
    results: await searchContent({
      q,
      type,
      limit,
      lang: pickLocale(req.get('accept-language')),
    }),
  });
});

/**
 * Resolves the refs a row already holds, so the editor can show titles.
 *
 * Read-only, so a VIEWER may call it. Refs that resolve to nothing are absent
 * from the response rather than an error — the editor renders those as
 * unavailable, which is the warning that they will not appear on Home.
 */
adminHomeRouter.get('/content-lookup', async (req: Request, res: Response) => {
  const { refs } = parseOrThrow(contentLookupQuery, req.query);

  res.json({
    results: await lookupContent(refs, pickLocale(req.get('accept-language'))),
  });
});

adminHomeRouter.get('/rows', async (_req: Request, res: Response) => {
  res.json({ rows: await listHomeRows() });
});

adminHomeRouter.post('/rows', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const input = parseOrThrow(homeRowCreateBody, req.body ?? {});

  const created = await createHomeRow({
    titleI18n: input.title_i18n,
    order: input.order,
    itemRefs: input.item_refs,
  });

  await recordAudit({
    adminUserId: callerId(req),
    action: 'HOME_ROW_CREATE',
    entityType: 'home_row',
    entityId: created.id,
  });

  res.status(201).json({ row: created });
});

/**
 * Bulk reorder.
 *
 * Declared before `/rows/:id` because Express matches in declaration order:
 * "reorder" would otherwise be parsed as a row id by any handler on that path
 * sharing this method. Nothing does today — the id routes are GET/PATCH/DELETE
 * — but the ordering makes that a fact about this file rather than a
 * coincidence to be rediscovered when a PUT /rows/:id is added.
 */
adminHomeRouter.put('/rows/reorder', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { ids } = parseOrThrow(homeRowReorderBody, req.body ?? {});

  const rows = await reorderHomeRows(ids);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'HOME_ROW_REORDER',
    entityType: 'home_row',
  });

  res.json({ rows });
});

adminHomeRouter.get('/rows/:id', async (req: Request, res: Response) => {
  const { id } = parseOrThrow(homeRowIdParam, req.params);

  res.json({ row: await requireHomeRow(id) });
});

adminHomeRouter.patch('/rows/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(homeRowIdParam, req.params);
  const input = parseOrThrow(homeRowUpdateBody, req.body ?? {});

  const updated = await updateHomeRow(id, {
    titleI18n: input.title_i18n,
    order: input.order,
    itemRefs: input.item_refs,
  });

  await recordAudit({
    adminUserId: callerId(req),
    action: 'HOME_ROW_UPDATE',
    entityType: 'home_row',
    entityId: id,
  });

  res.json({ row: updated });
});

/** Removes the editorial row. The content it referenced is untouched. */
adminHomeRouter.delete('/rows/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(homeRowIdParam, req.params);

  await deleteHomeRow(id);

  await recordAudit({
    adminUserId: callerId(req),
    action: 'HOME_ROW_DELETE',
    entityType: 'home_row',
    entityId: id,
  });

  res.status(204).end();
});

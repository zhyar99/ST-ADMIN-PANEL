import { Router, type Request, type Response } from 'express';

import { adminAuth } from '../../middleware/adminAuth';
import { uploadLimiter } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import {
  approveEntryBody,
  bulkApproveBody,
  entryParams,
  jobIdParam,
  linkTargetsQuery,
  listEntriesQuery,
  listJobsQuery,
  rejectEntryBody,
} from '../../schemas/importSchemas';
import {
  approveEntry,
  bulkApproveEntries,
  createImportJob,
  deleteImportJob,
  getImportJobDetail,
  listImportEntries,
  listImportJobs,
  listLinkTargets,
  rejectEntry,
  requireImportJob,
} from '../../services/import/importService';
import { uploadPlaylistFile } from '../../services/import/playlistUpload';

/**
 * Bulk playlist import (Phase 14).
 *
 * Reads are open to any authenticated admin so a VIEWER can watch an import
 * land; every mutation is ADMIN-gated. The one thing a VIEWER must not see is
 * `raw_url`, which carries the same secret as `stream_source.url` — that is
 * decided once, in {@link isAdmin}, and passed into the service as
 * `includeUrl`, so no read path can leak it by forgetting to strip a field.
 */
export const adminImportRouter: Router = Router();

adminImportRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

function isAdmin(req: Request): boolean {
  return req.admin?.role === 'ADMIN';
}

/**
 * POST /jobs — multipart, field "playlist".
 *
 * The middleware chain is the security boundary and its order is load-bearing:
 * authentication, then the role gate, then the rate limiter, then multer, which
 * rejects a bad extension and aborts an oversized body before the service sees
 * a single byte.
 */
adminImportRouter.post(
  '/jobs',
  requireRole('ADMIN'),
  // Parsing a playlist is the most expensive request this API serves, so it
  // carries the upload budget (30 per IP per 15 minutes) as well as the admin
  // write limiter that every POST under /admin already gets.
  uploadLimiter,
  uploadPlaylistFile,
  async (req: Request, res: Response) => {
    const file = req.file;

    if (!file) throw new HttpError(400, 'FILE_REQUIRED', 'No playlist file was uploaded');

    const job = await createImportJob(
      callerId(req),
      // The client controls this string; it is stored and echoed, never used to
      // build a path, and the basename keeps a full local path out of the UI.
      file.originalname.split(/[\\/]/).at(-1)?.slice(0, 255) || 'playlist.m3u',
      file.buffer.toString('utf8'),
    );

    await recordAudit({
      adminUserId: callerId(req),
      action: 'IMPORT_JOB_CREATE',
      entityType: 'import_job',
      entityId: job.id,
    });

    res.status(201).json({ job });
  },
);

adminImportRouter.get('/jobs', async (req: Request, res: Response) => {
  const query = parseOrThrow(listJobsQuery, req.query);
  res.json(await listImportJobs(query));
});

/**
 * Search for a catalogue item to link an entry to.
 *
 * Declared before `/jobs/:jobId` matters not at all — it is a different path —
 * but it lives here, next to the approve route it feeds, rather than in the
 * catalogue routers, because it is the only search that spans drafts as well as
 * published items and it exists solely for this flow.
 */
adminImportRouter.get('/link-targets', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const query = parseOrThrow(linkTargetsQuery, req.query);
  res.json({ targets: await listLinkTargets(query) });
});

adminImportRouter.get('/jobs/:jobId', async (req: Request, res: Response) => {
  const { jobId } = parseOrThrow(jobIdParam, req.params);
  res.json({ job: await getImportJobDetail(jobId) });
});

adminImportRouter.get('/jobs/:jobId/entries', async (req: Request, res: Response) => {
  const { jobId } = parseOrThrow(jobIdParam, req.params);
  const query = parseOrThrow(listEntriesQuery, req.query);

  await requireImportJob(jobId);

  res.json(await listImportEntries({ jobId, ...query, includeUrl: isAdmin(req) }));
});

adminImportRouter.patch(
  '/jobs/:jobId/entries/:entryId/approve',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { jobId, entryId } = parseOrThrow(entryParams, req.params);
    const { mappedType, targetId, createNew } = parseOrThrow(approveEntryBody, req.body ?? {});

    const entry = await approveEntry(jobId, entryId, mappedType, { targetId, createNew });

    await recordAudit({
      adminUserId: callerId(req),
      action: 'IMPORT_APPROVE',
      entityType: 'import_entry',
      entityId: entryId,
    });

    res.json({ entry });
  },
);

adminImportRouter.patch(
  '/jobs/:jobId/entries/:entryId/reject',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { jobId, entryId } = parseOrThrow(entryParams, req.params);
    const { note } = parseOrThrow(rejectEntryBody, req.body ?? {});

    const entry = await rejectEntry(jobId, entryId, note);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'IMPORT_REJECT',
      entityType: 'import_entry',
      entityId: entryId,
    });

    res.json({ entry });
  },
);

adminImportRouter.post(
  '/jobs/:jobId/bulk-approve',
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    const { jobId } = parseOrThrow(jobIdParam, req.params);
    const { mappedType, createNew, entryIds } = parseOrThrow(bulkApproveBody, req.body ?? {});

    const result = await bulkApproveEntries(jobId, mappedType, createNew, entryIds);

    await recordAudit({
      adminUserId: callerId(req),
      action: 'IMPORT_BULK_APPROVE',
      entityType: 'import_job',
      entityId: jobId,
    });

    res.json(result);
  },
);

adminImportRouter.delete('/jobs/:jobId', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { jobId } = parseOrThrow(jobIdParam, req.params);
  const actorId = callerId(req);

  await deleteImportJob(jobId);

  await recordAudit({
    adminUserId: actorId,
    action: 'IMPORT_JOB_DELETE',
    entityType: 'import_job',
    entityId: jobId,
  });

  res.status(204).end();
});

import { Router, type Request, type Response } from 'express';

import { adminAuth } from '../../middleware/adminAuth';
import { uploadLimiter } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/rbac';
import { HttpError } from '../../middleware/errorHandler';
import { parseOrThrow } from '../../lib/validate';
import { recordAudit } from '../../lib/audit';
import { assetIdParam, listAssetsQuery } from '../../schemas/assetSchemas';
import { createAsset, deleteAsset, getAssetById, listAssets } from '../../services/assets/assetService';
import { discardUpload, validateImage } from '../../services/assets/imageValidator';
import { resolveAssetKind, uploadAssetFile } from '../../services/assets/uploadMiddleware';

export const adminAssetsRouter: Router = Router();

// Browsing the library is open to any authenticated admin; deleting is not.
adminAssetsRouter.use(adminAuth);

function callerId(req: Request): string {
  const id = req.admin?.adminUserId;
  if (!id) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

/**
 * POST /upload/:kind — multipart, field "file".
 *
 * The middleware chain is the security boundary: kind is resolved from a fixed
 * allowlist, then multer rejects a bad type before opening a write stream and
 * aborts an oversized body mid-stream, then sharp checks the pixels.
 */
adminAssetsRouter.post(
  '/upload/:kind',
  // Uploads cost disk and a sharp decode each, so they carry their own budget
  // (30 per IP per 15 minutes) on top of the admin write limiter.
  uploadLimiter,
  resolveAssetKind,
  uploadAssetFile,
  async (req: Request, res: Response) => {
    const kind = req.assetKind;
    const file = req.file;

    if (!kind || !file) {
      throw new HttpError(400, 'FILE_REQUIRED', 'No file was uploaded');
    }

    const dimensions = await validateImage(file.path, kind);

    let asset;
    try {
      asset = await createAsset({
        kind,
        fileName: file.filename,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        dimensions,
      });
    } catch (error) {
      // Without this the file would outlive the failed insert as an orphan.
      await discardUpload(file.path);
      throw error;
    }

    await recordAudit({
      adminUserId: callerId(req),
      action: 'ASSET_UPLOAD',
      entityType: 'media_asset',
      entityId: asset.id,
    });

    res.status(201).json({ asset });
  },
);

adminAssetsRouter.get('/', async (req: Request, res: Response) => {
  const query = parseOrThrow(listAssetsQuery, req.query);
  res.json(await listAssets(query));
});

adminAssetsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = parseOrThrow(assetIdParam, req.params);
  res.json({ asset: await getAssetById(id) });
});

adminAssetsRouter.delete('/:id', requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = parseOrThrow(assetIdParam, req.params);
  const actorId = callerId(req);

  await deleteAsset(id);

  await recordAudit({
    adminUserId: actorId,
    action: 'ASSET_DELETE',
    entityType: 'media_asset',
    entityId: id,
  });

  res.status(204).end();
});

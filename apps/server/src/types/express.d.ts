import type { AdminTokenPayload } from '../lib/tokens';
import type { AssetKind } from '../services/assets/policy';

export {};

declare global {
  namespace Express {
    interface Request {
      /** Correlation id set by the requestId middleware. */
      id?: string;
      /** Verified admin claims set by the adminAuth middleware. */
      admin?: AdminTokenPayload;
      /** Upload target resolved from `:kind` by the resolveAssetKind middleware. */
      assetKind?: AssetKind;
    }

    interface Locals {
      /**
       * The calling device, set by the deviceIdentity middleware.
       *
       * Null when the request carried no `X-Device-ID`, which is legal: every
       * personalized endpoint degrades to an anonymous, global response rather
       * than refusing. It lives on `res.locals` rather than `req` because it is
       * request-scoped state derived from a header, not a claim about who the
       * caller is — there is no authentication here to speak of.
       */
      deviceId?: string | null;
    }
  }
}

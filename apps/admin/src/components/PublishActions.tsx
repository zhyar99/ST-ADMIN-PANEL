import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Eye, EyeOff, Loader2 } from 'lucide-react';
import type { PublicationStatus } from '@streaming/shared';

import { ApiError } from '../lib/api';
import { useAuth } from '../lib/authContext';
import { publishContent, unpublishContent, type PublishTarget } from '../lib/publishApi';
import StatusBadge from './StatusBadge';

/**
 * The publish / unpublish control shared by every content edit page.
 *
 * Which buttons exist is driven by the status rather than by disabling them:
 * a published item has nothing to publish, so offering a greyed-out "Publish"
 * would only invite a click that can never do anything. Disabling is reserved
 * for the in-flight state, where the action is real but momentarily unavailable.
 */

const BUTTON_BASE =
  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40';

/** What the current status means for a viewer, in one line. */
const STATUS_HINTS: Record<PublicationStatus, string> = {
  DRAFT: 'Not visible to viewers yet.',
  PUBLISHED: 'Live and visible to viewers.',
  UNPUBLISHED: 'Hidden from viewers.',
};

export type PublishActionsProps = PublishTarget & {
  currentStatus: PublicationStatus;
  onStatusChange: (status: PublicationStatus) => void;
};

export default function PublishActions({
  currentStatus,
  onStatusChange,
  ...target
}: PublishActionsProps) {
  const { isAdmin } = useAuth();
  const canPublish = isAdmin();

  /** Unmet requirements from the last 422, or null. */
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (next: 'PUBLISHED' | 'UNPUBLISHED') =>
      next === 'PUBLISHED' ? publishContent(target) : unpublishContent(target),
    onMutate: () => {
      setReasons(null);
      setError(null);
    },
    onSuccess: (result) => {
      onStatusChange(result.status);
    },
    onError: (cause) => {
      // A 422 is the expected outcome of publishing something unfinished, so it
      // renders as a checklist of what to fix rather than as a failure.
      if (cause instanceof ApiError && cause.status === 422 && cause.reasons.length > 0) {
        setReasons(cause.reasons);
        return;
      }

      setError(cause instanceof ApiError ? cause.message : 'Could not change the publish status.');
    },
  });

  const isBusy = mutation.isPending;

  return (
    <div className="mb-5 rounded-lg border border-slate-800 bg-slate-900/40 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <StatusBadge status={currentStatus} />
          <p className="text-xs text-slate-400">{STATUS_HINTS[currentStatus]}</p>
        </div>

        {canPublish && (
          <div className="flex gap-2">
            {currentStatus !== 'PUBLISHED' && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => mutation.mutate('PUBLISHED')}
                className={`${BUTTON_BASE} bg-emerald-500/15 text-emerald-200 ring-1 ring-inset ring-emerald-500/30 hover:bg-emerald-500/25`}
              >
                {isBusy ? (
                  <Loader2 size={14} aria-hidden className="animate-spin" />
                ) : (
                  <Eye size={14} aria-hidden />
                )}
                Publish
              </button>
            )}

            {currentStatus === 'PUBLISHED' && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => mutation.mutate('UNPUBLISHED')}
                className={`${BUTTON_BASE} border border-slate-700 text-slate-300 hover:bg-slate-800`}
              >
                {isBusy ? (
                  <Loader2 size={14} aria-hidden className="animate-spin" />
                ) : (
                  <EyeOff size={14} aria-hidden />
                )}
                Unpublish
              </button>
            )}
          </div>
        )}
      </div>

      {reasons && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5"
        >
          <p className="flex items-center gap-1.5 text-sm font-medium text-amber-200">
            <AlertTriangle size={14} aria-hidden />
            Not ready to publish
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-7 text-xs text-amber-100/90">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
          {error}
        </p>
      )}
    </div>
  );
}

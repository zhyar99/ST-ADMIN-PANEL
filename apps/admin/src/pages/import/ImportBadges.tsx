import type { ImportEntryStatus, ImportJobStatus } from '@streaming/shared';

/**
 * Status pills for the import screens.
 *
 * Same shape and palette as `StatusBadge`, kept separate because these describe
 * a review queue rather than a publication lifecycle — DRAFT and STAGED are not
 * the same idea and should not share a component that maps one to the other.
 */

const BADGE_BASE =
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset';

const JOB_STYLES: Record<ImportJobStatus, string> = {
  PENDING: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  PROCESSING: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  DONE: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  FAILED: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
};

const JOB_LABELS: Record<ImportJobStatus, string> = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  DONE: 'Done',
  FAILED: 'Failed',
};

export function JobStatusBadge({ status }: { status: ImportJobStatus }) {
  return <span className={`${BADGE_BASE} ${JOB_STYLES[status]}`}>{JOB_LABELS[status]}</span>;
}

const ENTRY_STYLES: Record<ImportEntryStatus, string> = {
  STAGED: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  APPROVED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  REJECTED: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  DUPLICATE: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
};

const ENTRY_LABELS: Record<ImportEntryStatus, string> = {
  STAGED: 'Staged',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  DUPLICATE: 'Duplicate',
};

export function EntryStatusBadge({ status }: { status: ImportEntryStatus }) {
  return <span className={`${BADGE_BASE} ${ENTRY_STYLES[status]}`}>{ENTRY_LABELS[status]}</span>;
}

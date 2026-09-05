import type { PublicationStatus, StreamTestResult } from '@streaming/shared';

const STATUS_STYLES: Record<PublicationStatus, string> = {
  DRAFT: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  PUBLISHED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  UNPUBLISHED: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
};

const STATUS_LABELS: Record<PublicationStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  UNPUBLISHED: 'Unpublished',
};

const BADGE_BASE =
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset';

export default function StatusBadge({ status }: { status: PublicationStatus }) {
  return <span className={`${BADGE_BASE} ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>;
}

/** Health of a stream source. `null` means it has never been tested. */
export function TestResultBadge({ result }: { result: StreamTestResult | null }) {
  if (result === null) {
    return (
      <span className={`${BADGE_BASE} bg-slate-500/15 text-slate-400 ring-slate-500/30`}>
        Never tested
      </span>
    );
  }

  return (
    <span
      className={`${BADGE_BASE} ${
        result === 'OK'
          ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
          : 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
      }`}
    >
      {result === 'OK' ? 'OK' : 'Failed'}
    </span>
  );
}

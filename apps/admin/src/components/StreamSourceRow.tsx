import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Eye, History, Loader2, Trash2, Zap } from 'lucide-react';
import type { StreamSourceDto } from '@streaming/shared';

import { listSourceHealthHistory } from '../lib/catalogApi';
import { TestResultBadge } from './StatusBadge';

/**
 * One row of the stream source table, shared by Movies, Episodes and Live
 * Channels through `StreamSourceManager`.
 *
 * Everything owner-specific arrives as a callback, so the row knows nothing
 * about which entity it belongs to — except for the health history, which the
 * server serves by bare source id and which the row therefore fetches itself.
 */

/** Width of the history popover, in px. Also used to position it. */
const POPOVER_WIDTH = 288;

export function formatDateTime(value: string | null): string {
  return value === null
    ? '—'
    : new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatLatency(latencyMs: number | null): string {
  return latencyMs === null ? '—' : `${latencyMs} ms`;
}

const ACTION_CLASS =
  'flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-50';

const ICON_ACTION_CLASS =
  'rounded-md border border-slate-700 p-1.5 text-slate-300 transition hover:bg-slate-800 disabled:opacity-30';

/**
 * The last ≤20 checks for one source.
 *
 * Deliberately not a `useQuery` on mount: a page with six sources would fire
 * six history requests nobody asked for. The query is enabled only while the
 * popover is open, and refetches on every open so a check run since the last
 * peek is included.
 */
function HealthHistoryPopover({ sourceId }: { sourceId: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const historyQuery = useQuery({
    queryKey: ['admin', 'stream-sources', sourceId, 'health-history'],
    queryFn: () => listSourceHealthHistory(sourceId),
    enabled: open,
    refetchOnMount: 'always',
    staleTime: 0,
  });

  // Positioned fixed rather than absolute: the table sits inside an
  // `overflow-hidden` wrapper, which would clip a panel positioned within it.
  useLayoutEffect(() => {
    if (!open) return;

    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    setPosition({
      top: rect.bottom + 6,
      // Right-aligned to the trigger, but never off the left edge.
      left: Math.max(8, rect.right - POPOVER_WIDTH),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    // Scrolling would leave the fixed panel behind; closing is less jarring
    // than a panel drifting away from its row.
    function onScroll() {
      setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const items = historyQuery.data ?? [];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Test history"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={ICON_ACTION_CLASS}
      >
        <History size={14} aria-hidden />
      </button>

      {open && position && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Test history"
          style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
          className="fixed z-40 rounded-lg border border-slate-700 bg-slate-900 p-3 text-left shadow-xl"
        >
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            Recent checks
          </p>

          {historyQuery.isPending && (
            <div className="space-y-2" aria-hidden>
              {[0, 1, 2].map((key) => (
                <div key={key} className="h-8 animate-pulse rounded bg-slate-800" />
              ))}
            </div>
          )}

          {historyQuery.isError && (
            <p className="text-xs text-rose-300">Could not load the history.</p>
          )}

          {historyQuery.isSuccess && items.length === 0 && (
            <p className="text-xs text-slate-400">No checks yet.</p>
          )}

          {items.length > 0 && (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className="rounded-md bg-slate-950/60 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-300">{formatDateTime(item.checkedAt)}</span>
                    <span
                      className={`text-xs font-medium ${
                        item.result === 'OK' ? 'text-emerald-300' : 'text-rose-300'
                      }`}
                    >
                      {item.result === 'OK' ? 'OK' : 'Failed'}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                    <span>{formatLatency(item.latencyMs)}</span>
                    {item.errorMessage && (
                      <span className="truncate text-rose-300/80" title={item.errorMessage}>
                        {item.errorMessage}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

export interface StreamSourceRowProps {
  source: StreamSourceDto;
  /** Position in the list. 0 is the primary source. */
  index: number;
  isLast: boolean;
  isTesting: boolean;
  isReordering: boolean;
  onMove: (direction: -1 | 1) => void;
  onTest: () => void;
  onRevealUrl: () => void;
  onDelete: () => void;
}

export default function StreamSourceRow({
  source,
  index,
  isLast,
  isTesting,
  isReordering,
  onMove,
  onTest,
  onRevealUrl,
  onDelete,
}: StreamSourceRowProps) {
  return (
    <tr className="text-slate-300">
      <td className="px-4 py-3">
        {index === 0 ? (
          <span className="font-medium text-slate-100">Primary</span>
        ) : (
          <span>Backup {index}</span>
        )}
      </td>
      <td className="px-4 py-3">
        <TestResultBadge result={source.lastTestResult} />
      </td>
      <td className="px-4 py-3 text-slate-400">{formatDateTime(source.lastTestedAt)}</td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            aria-label="Move up"
            disabled={index === 0 || isReordering}
            onClick={() => onMove(-1)}
            className={ICON_ACTION_CLASS}
          >
            <ArrowUp size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Move down"
            disabled={isLast || isReordering}
            onClick={() => onMove(1)}
            className={ICON_ACTION_CLASS}
          >
            <ArrowDown size={14} aria-hidden />
          </button>
          <button type="button" onClick={onRevealUrl} className={ACTION_CLASS}>
            <Eye size={13} aria-hidden />
            View URL
          </button>
          <button type="button" disabled={isTesting} onClick={onTest} className={ACTION_CLASS}>
            {isTesting ? (
              <Loader2 size={13} className="animate-spin" aria-hidden />
            ) : (
              <Zap size={13} aria-hidden />
            )}
            Test source
          </button>
          <HealthHistoryPopover sourceId={source.id} />
          <button
            type="button"
            aria-label="Delete source"
            onClick={onDelete}
            className="rounded-md border border-slate-700 p-1.5 text-rose-300 transition hover:bg-slate-800"
          >
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </td>
    </tr>
  );
}

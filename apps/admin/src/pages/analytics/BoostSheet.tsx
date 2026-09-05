import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import type { ContentSearchResult, DeviceContentType } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { createBoost } from '../../lib/analyticsApi';
import { searchContent } from '../../lib/homeApi';
import { analyticsKeys } from './analyticsKeys';

export interface BoostTarget {
  contentType: DeviceContentType;
  contentId: string;
  title: string;
}

interface BoostSheetProps {
  open: boolean;
  onClose: () => void;
  /** Pre-selected content, when the sheet was opened from a Trending row. */
  target?: BoostTarget | null;
}

/**
 * The label for a score, in the operator's language rather than in numbers.
 *
 * A slider from -1 to +1 is meaningless on its own — the whole point of the
 * control is that someone deciding "should this be pinned" is not thinking in
 * additive score deltas.
 */
function describeScore(score: number): string {
  if (score <= -0.1) return 'Bury (hide from recommendations)';
  if (score < 0.1) return 'Neutral (no change)';
  if (score <= 0.5) return 'Boost';
  return 'Pin near top';
}

/**
 * Slide-in panel for setting an editorial boost.
 *
 * Built from Tailwind rather than a shadcn/ui `Sheet`: this SPA has no Radix or
 * shadcn dependency — its dialogs are the hand-rolled `Modal` component — and
 * introducing a component library for one panel would be a bigger change to the
 * app than the feature it is serving.
 */
export default function BoostSheet({ open, onClose, target }: BoostSheetProps) {
  const queryClient = useQueryClient();

  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<BoostTarget | null>(null);
  const [score, setScore] = useState(0.5);
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  // Reopening the sheet must not show the previous decision.
  useEffect(() => {
    if (!open) return;
    setSelected(target ?? null);
    setTerm('');
    setScore(0.5);
    setReason('');
    setExpiresAt('');
  }, [open, target]);

  const results = useQuery({
    queryKey: ['admin', 'analytics', 'boost-search', term],
    queryFn: () => searchContent({ q: term }),
    enabled: open && !selected && term.trim().length > 1,
  });

  const submit = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('No content selected');

      return createBoost({
        content_type: selected.contentType,
        content_id: selected.contentId,
        boost_score: Number(score.toFixed(2)),
        reason: reason.trim() === '' ? undefined : reason.trim(),
        // A date input gives a local calendar day; the API takes an instant.
        expires_at: expiresAt === '' ? null : new Date(`${expiresAt}T23:59:59`).toISOString(),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: analyticsKeys.boosts });
      onClose();
    },
  });

  if (!open) return null;

  const pick = (result: ContentSearchResult) =>
    setSelected({
      contentType: result.type,
      contentId: result.id,
      title: result.title,
    });

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/70"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Set recommendation boost"
        className="flex h-full w-full max-w-md flex-col border-l border-slate-800 bg-slate-900 shadow-xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Recommendation boost</h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Applies to every device&apos;s ranking, on top of its own signals.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section>
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Content
            </span>

            {selected ? (
              <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-100">{selected.title}</span>
                  <span className="text-xs text-slate-500">{selected.contentType}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="shrink-0 text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="mt-2">
                <label className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5">
                  <Search size={14} className="text-slate-500" aria-hidden />
                  <input
                    type="search"
                    value={term}
                    onChange={(event) => setTerm(event.target.value)}
                    placeholder="Search published content"
                    className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-600"
                  />
                </label>

                <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {(results.data ?? []).map((result) => (
                    <li key={`${result.type}:${result.id}`}>
                      <button
                        type="button"
                        onClick={() => pick(result)}
                        className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm text-slate-200 transition hover:bg-slate-800"
                      >
                        <span className="min-w-0 truncate">{result.title}</span>
                        <span className="shrink-0 text-xs text-slate-500">{result.type}</span>
                      </button>
                    </li>
                  ))}
                  {results.isFetched && (results.data ?? []).length === 0 && (
                    <li className="px-2.5 py-1.5 text-xs text-slate-500">No matches.</li>
                  )}
                </ul>
              </div>
            )}
          </section>

          <section>
            <label
              htmlFor="boost-score"
              className="text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Boost score
            </label>
            <input
              id="boost-score"
              type="range"
              min={-1}
              max={1}
              step={0.1}
              value={score}
              onChange={(event) => setScore(Number(event.target.value))}
              className="mt-2 w-full accent-sky-500"
            />
            <p className="mt-1 flex items-center justify-between text-xs">
              <span className="text-slate-300">{describeScore(score)}</span>
              <span className="tabular-nums text-slate-500">{score.toFixed(1)}</span>
            </p>
          </section>

          <section>
            <label
              htmlFor="boost-reason"
              className="text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Reason <span className="normal-case text-slate-600">(optional)</span>
            </label>
            <input
              id="boost-reason"
              type="text"
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Sponsored content — Q4 campaign"
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-slate-500"
            />
          </section>

          <section>
            <label
              htmlFor="boost-expires"
              className="text-xs font-medium uppercase tracking-wide text-slate-500"
            >
              Expires <span className="normal-case text-slate-600">(optional)</span>
            </label>
            <input
              id="boost-expires"
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-slate-500"
            />
          </section>

          {submit.isError && (
            <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {submit.error instanceof ApiError ? submit.error.message : 'Could not save the boost.'}
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected || submit.isPending}
            onClick={() => submit.mutate()}
            className="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submit.isPending ? 'Saving…' : 'Save boost'}
          </button>
        </footer>
      </aside>
    </div>
  );
}

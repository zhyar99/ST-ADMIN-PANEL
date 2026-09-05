import { useQuery } from '@tanstack/react-query';

import { getDeviceOverview } from '../../lib/analyticsApi';
import { analyticsKeys } from './analyticsKeys';
import StatTile from './StatTile';

const PERIODS = [7, 14, 30, 90] as const;

/** Auto-refresh cadence. Slow enough to be free, fast enough to feel live. */
const REFETCH_MS = 60_000;

interface OverviewTabProps {
  periodDays: number;
  onPeriodChange: (days: number) => void;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

/**
 * Platform-wide device activity.
 *
 * The genre chart is plain Tailwind — styled divs with a percentage width —
 * rather than a charting library. It is a ranked bar list of at most ten rows,
 * which is the one shape a chart library adds nothing to, and adding one would
 * put ~50 kB into a bundle that currently has no charting dependency at all.
 */
export default function OverviewTab({ periodDays, onPeriodChange }: OverviewTabProps) {
  const overview = useQuery({
    queryKey: analyticsKeys.overview(periodDays),
    queryFn: () => getDeviceOverview(periodDays),
    refetchInterval: REFETCH_MS,
  });

  const data = overview.data;
  const topGenreCount = Math.max(1, ...(data?.top_genres.map((g) => g.affinity_count) ?? [1]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-slate-400">
          Device activity over the last {periodDays} days. Refreshes every minute.
        </p>

        <div role="tablist" aria-label="Period" className="flex gap-1">
          {PERIODS.map((days) => (
            <button
              key={days}
              type="button"
              role="tab"
              aria-selected={days === periodDays}
              onClick={() => onPeriodChange(days)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                days === periodDays
                  ? 'bg-slate-100 text-slate-900'
                  : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      {overview.isError && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          Could not load device analytics.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Total devices" value={formatNumber(data?.total_devices ?? 0)} hint="All time" />
        <StatTile
          label="Active devices"
          value={formatNumber(data?.active_devices_in_period ?? 0)}
          hint={`Seen in the last ${periodDays} days`}
        />
        <StatTile
          label="New devices"
          value={formatNumber(data?.new_devices_in_period ?? 0)}
          hint={`First seen in the last ${periodDays} days`}
        />
        <StatTile
          label="Watch hours"
          value={formatNumber(Math.round(data?.total_watch_hours ?? 0))}
          hint={`${formatNumber(data?.avg_watch_seconds_per_device ?? 0)}s per active device`}
        />
      </div>

      <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <h2 className="text-sm font-semibold text-slate-100">Genre affinity distribution</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Devices with a non-zero affinity score for each genre. Top ten.
        </p>

        <ul className="mt-4 space-y-2">
          {(data?.top_genres ?? []).map((entry) => (
            <li key={entry.genre_id} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate text-xs text-slate-300">
                {entry.genre_name}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                <span
                  className="block h-full rounded-full bg-sky-500/80"
                  style={{ width: `${(entry.affinity_count / topGenreCount) * 100}%` }}
                />
              </span>
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-400">
                {formatNumber(entry.affinity_count)}
              </span>
            </li>
          ))}
          {data && data.top_genres.length === 0 && (
            <li className="text-xs text-slate-500">
              No device has built a genre affinity yet.
            </li>
          )}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-100">Content type breakdown</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatTile
            label="Movies watched"
            value={formatNumber(data?.content_type_breakdown.MOVIE ?? 0)}
            hint="Watch events in period"
          />
          <StatTile
            label="Episodes watched"
            value={formatNumber(data?.content_type_breakdown.EPISODE ?? 0)}
            hint="Watch events in period"
          />
          <StatTile
            label="Live TV watched"
            value={formatNumber(data?.content_type_breakdown.LIVE_CHANNEL ?? 0)}
            hint="Watch events in period"
          />
        </div>
      </section>
    </div>
  );
}

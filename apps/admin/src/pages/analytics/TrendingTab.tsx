import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { TrendingUp } from 'lucide-react';
import type { TrendingContentItem, WatchContentType } from '@streaming/shared';

import { useAuth } from '../../lib/authContext';
import { getTrending } from '../../lib/analyticsApi';
import { analyticsKeys } from './analyticsKeys';
import BoostSheet, { type BoostTarget } from './BoostSheet';

type TypeFilter = WatchContentType | 'ALL';

const TYPE_TABS: ReadonlyArray<{ label: string; value: TypeFilter }> = [
  { label: 'All', value: 'ALL' },
  { label: 'Movies', value: 'MOVIE' },
  { label: 'Series', value: 'EPISODE' },
  { label: 'Live TV', value: 'LIVE_CHANNEL' },
];

const PERIODS = [7, 30] as const;

const TYPE_LABEL: Record<WatchContentType, string> = {
  MOVIE: 'Movie',
  EPISODE: 'Episode',
  LIVE_CHANNEL: 'Live TV',
};

/**
 * A boostable ref for a trending row.
 *
 * Trending is reported per *watched* thing, so an episode; boosts apply to what
 * a device can be recommended, which is a series. An episode row therefore has
 * nothing to boost — the operator boosts the show from the Boosts tab instead —
 * and the button is withheld rather than sending a ref the API would reject.
 */
function boostTargetFor(item: TrendingContentItem): BoostTarget | null {
  if (item.content_type === 'EPISODE') return null;

  return {
    contentType: item.content_type,
    contentId: item.content_id,
    title: item.title,
  };
}

const columnHelper = createColumnHelper<TrendingContentItem>();

export default function TrendingTab() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  const [periodDays, setPeriodDays] = useState<number>(7);
  const [type, setType] = useState<TypeFilter>('ALL');
  const [boostTarget, setBoostTarget] = useState<BoostTarget | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const trending = useQuery({
    queryKey: analyticsKeys.trending(periodDays, type),
    queryFn: () =>
      getTrending({
        periodDays,
        contentType: type === 'ALL' ? undefined : type,
        limit: 25,
      }),
    placeholderData: keepPreviousData,
  });

  /**
   * Where a trending row links to.
   *
   * Movies and channels have an edit page addressed by their own id. An episode
   * does not — its route is nested under a series and a season, and this table
   * knows neither — so those rows are not links.
   */
  function openContent(item: TrendingContentItem) {
    if (item.content_type === 'MOVIE') navigate(`/movies/${item.content_id}`);
    if (item.content_type === 'LIVE_CHANNEL') navigate(`/live-tv/${item.content_id}`);
  }

  const columns = [
    columnHelper.display({
      id: 'rank',
      header: '#',
      cell: (info) => <span className="tabular-nums text-slate-500">{info.row.index + 1}</span>,
    }),
    columnHelper.display({
      id: 'thumbnail',
      header: '',
      cell: (info) => {
        const url = info.row.original.poster_url;
        return url ? (
          <img
            src={url}
            alt=""
            className="h-10 w-7 rounded object-cover"
            loading="lazy"
          />
        ) : (
          <span className="block h-10 w-7 rounded bg-slate-800" aria-hidden />
        );
      },
    }),
    columnHelper.accessor('title', {
      header: 'Title',
      cell: (info) => {
        const item = info.row.original;
        const linkable = item.content_type !== 'EPISODE';

        return linkable ? (
          <button
            type="button"
            onClick={() => openContent(item)}
            className="text-left font-medium text-slate-100 underline-offset-2 hover:underline"
          >
            {info.getValue()}
          </button>
        ) : (
          <span className="font-medium text-slate-100">{info.getValue()}</span>
        );
      },
    }),
    columnHelper.accessor('content_type', {
      header: 'Type',
      cell: (info) => <span className="text-slate-400">{TYPE_LABEL[info.getValue()]}</span>,
    }),
    columnHelper.accessor('watch_count', {
      header: 'Watches',
      cell: (info) => <span className="tabular-nums">{info.getValue().toLocaleString()}</span>,
    }),
    columnHelper.accessor('unique_devices', {
      header: 'Devices',
      cell: (info) => (
        // The count only. Listing the device ids here would turn a popularity
        // table into a directory of everyone who watched something.
        <span className="tabular-nums">{info.getValue().toLocaleString()}</span>
      ),
    }),
    columnHelper.accessor('avg_completion_rate', {
      header: 'Avg completion',
      cell: (info) => (
        <span className="tabular-nums">{Math.round(info.getValue() * 100)}%</span>
      ),
    }),
    columnHelper.accessor('total_watch_hours', {
      header: 'Watch hours',
      cell: (info) => <span className="tabular-nums">{info.getValue().toLocaleString()}</span>,
    }),
    columnHelper.display({
      id: 'actions',
      header: '',
      cell: (info) => {
        const target = boostTargetFor(info.row.original);
        if (!isAdmin() || !target) return null;

        return (
          <button
            type="button"
            onClick={() => {
              setBoostTarget(target);
              setSheetOpen(true);
            }}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            Boost
          </button>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: trending.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Content type" className="flex gap-1">
          {TYPE_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={tab.value === type}
              onClick={() => setType(tab.value)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                tab.value === type
                  ? 'bg-slate-100 text-slate-900'
                  : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div role="tablist" aria-label="Period" className="flex gap-1">
          {PERIODS.map((days) => (
            <button
              key={days}
              type="button"
              role="tab"
              aria-selected={days === periodDays}
              onClick={() => setPeriodDays(days)}
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

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-500">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} className="px-3 py-2 font-medium">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-slate-800 text-slate-300">
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="hover:bg-slate-900/40">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {trending.isFetched && (trending.data ?? []).length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-sm text-slate-500">
                  <TrendingUp size={16} className="mx-auto mb-2 text-slate-700" aria-hidden />
                  Nothing has been watched in this period yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <BoostSheet
        open={sheetOpen}
        target={boostTarget}
        onClose={() => {
          setSheetOpen(false);
          setBoostTarget(null);
        }}
      />
    </div>
  );
}

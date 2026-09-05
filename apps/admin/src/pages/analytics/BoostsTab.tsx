import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import type { RecommendationBoostDTO } from '@streaming/shared';

import { useAuth } from '../../lib/authContext';
import { listBoosts, removeBoost } from '../../lib/analyticsApi';
import { analyticsKeys } from './analyticsKeys';
import BoostSheet from './BoostSheet';

/**
 * The score badge.
 *
 * Three bands rather than a number, because the number is only meaningful
 * relative to the weighted signals it is added to — an operator scanning the
 * table wants to know which way a title has been pushed, not by how much.
 */
function ScoreBadge({ score }: { score: number }) {
  const [label, classes] =
    score > 0.3
      ? ['Promoted', 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30']
      : score >= 0
        ? ['Slight boost', 'bg-slate-500/15 text-slate-300 ring-slate-500/30']
        : ['Buried', 'bg-red-500/15 text-red-300 ring-red-500/30'];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${classes}`}
    >
      {label}
      <span className="tabular-nums opacity-70">{score.toFixed(1)}</span>
    </span>
  );
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
}

const columnHelper = createColumnHelper<RecommendationBoostDTO>();

export default function BoostsTab() {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);

  const boosts = useQuery({ queryKey: analyticsKeys.boosts, queryFn: listBoosts });

  const remove = useMutation({
    mutationFn: (id: string) => removeBoost(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: analyticsKeys.boosts }),
  });

  const columns = [
    columnHelper.accessor((row) => row.title_i18n?.en ?? 'Unavailable content', {
      id: 'title',
      header: 'Content',
      cell: (info) => (
        <span className="font-medium text-slate-100">{info.getValue()}</span>
      ),
    }),
    columnHelper.accessor('content_type', {
      header: 'Type',
      cell: (info) => <span className="text-slate-400">{info.getValue()}</span>,
    }),
    columnHelper.accessor('boost_score', {
      header: 'Boost',
      cell: (info) => <ScoreBadge score={info.getValue()} />,
    }),
    columnHelper.accessor('reason', {
      header: 'Reason',
      cell: (info) => info.getValue() ?? <span className="text-slate-600">—</span>,
    }),
    columnHelper.accessor('expires_at', {
      header: 'Expires',
      cell: (info) => formatDate(info.getValue()),
    }),
    columnHelper.accessor('created_by_name', {
      header: 'Created by',
      cell: (info) => info.getValue() ?? <span className="text-slate-600">—</span>,
    }),
    columnHelper.display({
      id: 'actions',
      header: '',
      cell: (info) => {
        const boost = info.row.original;
        if (!isAdmin()) return null;

        // An inactive boost is history: it no longer affects any ranking, so
        // there is nothing left to remove.
        if (!boost.active) return <span className="text-xs text-slate-600">Removed</span>;

        return (
          <button
            type="button"
            onClick={() => remove.mutate(boost.id)}
            disabled={remove.isPending}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-50"
          >
            Remove
          </button>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: boosts.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="text-sm text-slate-400">
          Editorial adjustments applied to every device&apos;s ranking.
        </p>

        {isAdmin() && (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex items-center gap-1.5 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white"
          >
            <Plus size={14} aria-hidden />
            Add boost
          </button>
        )}
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
              <tr key={row.id} className={row.original.active ? '' : 'opacity-50'}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {boosts.isFetched && (boosts.data ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-500">
                  No boosts. Recommendations are ranked entirely by device signals.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <BoostSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  );
}

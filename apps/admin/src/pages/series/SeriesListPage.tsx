import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import type { PublicationStatus, SeriesListItemDto } from '@streaming/shared';

import { useAuth } from '../../lib/authContext';
import { listSeries } from '../../lib/seriesApi';
import StatusBadge from '../../components/StatusBadge';

const PAGE_SIZE = 20;

/** `undefined` is the "All" tab. */
type StatusFilter = PublicationStatus | undefined;

const STATUS_TABS: ReadonlyArray<{ label: string; value: StatusFilter }> = [
  { label: 'All', value: undefined },
  { label: 'Draft', value: 'DRAFT' },
  { label: 'Published', value: 'PUBLISHED' },
  { label: 'Unpublished', value: 'UNPUBLISHED' },
];

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const columnHelper = createColumnHelper<SeriesListItemDto>();

const columns = [
  columnHelper.accessor((row) => row.titleI18n.en, {
    id: 'title',
    header: 'Title',
    cell: (info) => <span className="font-medium text-slate-100">{info.getValue()}</span>,
  }),
  columnHelper.accessor('status', {
    header: 'Status',
    cell: (info) => <StatusBadge status={info.getValue()} />,
  }),
  columnHelper.accessor('seasonCount', {
    header: 'Seasons',
    cell: (info) => {
      const value = info.getValue();
      return value === 0 ? <span className="text-slate-600">None</span> : value;
    },
  }),
  columnHelper.accessor('createdAt', {
    header: 'Created',
    cell: (info) => formatDate(info.getValue()),
  }),
];

export default function SeriesListPage() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  const [status, setStatus] = useState<StatusFilter>(undefined);
  const [page, setPage] = useState(1);

  const seriesQuery = useQuery({
    queryKey: ['admin', 'series', status ?? 'ALL', page],
    queryFn: () => listSeries({ status, page, limit: PAGE_SIZE }),
    // Keeps the table on screen while a new page loads instead of flashing the
    // loading row on every pagination click.
    placeholderData: keepPreviousData,
  });

  const total = seriesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const table = useReactTable({
    data: seriesQuery.data?.items ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  function selectStatus(next: StatusFilter) {
    setStatus(next);
    setPage(1);
  }

  return (
    <div className="p-6">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Series</h1>
          {/* "series" is its own plural, so unlike the movies header this needs
              no count-dependent suffix. */}
          <p className="mt-1 text-sm text-slate-400">{total} series in the catalogue.</p>
        </div>

        {isAdmin() && (
          <button
            type="button"
            onClick={() => navigate('/series/new')}
            className="flex items-center gap-1.5 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white"
          >
            <Plus size={14} aria-hidden />
            New series
          </button>
        )}
      </header>

      <div role="tablist" className="mb-4 flex gap-1 border-b border-slate-800">
        {STATUS_TABS.map((tab) => {
          const isActive = tab.value === status;
          return (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => selectStatus(tab.value)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
                isActive
                  ? 'border-slate-200 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {seriesQuery.isError && (
        <p className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          Could not load series.
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-400">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} className="px-4 py-2.5 font-medium">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-slate-800">
            {seriesQuery.isPending && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}

            {seriesQuery.isSuccess && table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-slate-400">
                  No series here yet.
                </td>
              </tr>
            )}

            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => navigate(`/series/${row.original.id}`)}
                className="cursor-pointer text-slate-300 transition hover:bg-slate-900/60"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-slate-400">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
            className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => current + 1)}
            className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

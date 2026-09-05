import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { ImageOff, Pencil, Plus, Trash2 } from 'lucide-react';
import type { LiveChannelListItemDto, PublicationStatus } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { deleteLiveChannel, listChannelCategories, listLiveChannels } from '../../lib/liveTvApi';
import Modal from '../../components/Modal';
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

const columnHelper = createColumnHelper<LiveChannelListItemDto>();

export default function LiveTvListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const canManage = isAdmin();

  const [status, setStatus] = useState<StatusFilter>(undefined);
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [pendingDelete, setPendingDelete] = useState<LiveChannelListItemDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const channelsQuery = useQuery({
    queryKey: ['admin', 'live-channels', status ?? 'ALL', category || 'ALL', page],
    queryFn: () =>
      listLiveChannels({ status, category: category || undefined, page, limit: PAGE_SIZE }),
    // Keeps the table on screen while a new page loads instead of flashing the
    // loading row on every pagination click.
    placeholderData: keepPreviousData,
  });

  // Categories are free text, so the filter offers what is actually in use
  // rather than a fixed list that would drift from the data.
  const categoriesQuery = useQuery({
    queryKey: ['admin', 'live-channels', 'categories'],
    queryFn: listChannelCategories,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteLiveChannel(id),
    onSuccess: () => {
      setPendingDelete(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'live-channels'] });
    },
    onError: (cause) => {
      setPendingDelete(null);
      setError(cause instanceof ApiError ? cause.message : 'Could not delete this channel.');
    },
  });

  const total = channelsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = [
    columnHelper.display({
      id: 'logo',
      header: 'Logo',
      cell: (info) => {
        const logo = info.row.original.logo;
        return logo ? (
          <img
            src={logo.url}
            alt=""
            loading="lazy"
            className="h-8 w-8 rounded object-contain"
          />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded border border-dashed border-slate-700 text-slate-600">
            <ImageOff size={13} aria-hidden />
          </span>
        );
      },
    }),
    columnHelper.accessor((row) => row.nameI18n.en, {
      id: 'name',
      header: 'Name',
      cell: (info) => <span className="font-medium text-slate-100">{info.getValue()}</span>,
    }),
    columnHelper.accessor('category', {
      header: 'Category',
      cell: (info) => <span className="text-slate-300">{info.getValue()}</span>,
    }),
    columnHelper.accessor('status', {
      header: 'Status',
      cell: (info) => <StatusBadge status={info.getValue()} />,
    }),
    columnHelper.accessor('sourceCount', {
      header: 'Sources',
      cell: (info) => {
        const count = info.getValue();
        return count === 0 ? (
          <span className="text-amber-300/80">None</span>
        ) : (
          <span>
            {count} {count === 1 ? 'source' : 'sources'}
          </span>
        );
      },
    }),
    columnHelper.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => (
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            aria-label={`Edit ${info.row.original.nameI18n.en}`}
            onClick={() => navigate(`/live-tv/${info.row.original.id}`)}
            className="rounded-md border border-slate-700 p-1.5 text-slate-300 transition hover:bg-slate-800"
          >
            <Pencil size={14} aria-hidden />
          </button>
          {canManage && (
            <button
              type="button"
              aria-label={`Delete ${info.row.original.nameI18n.en}`}
              onClick={() => setPendingDelete(info.row.original)}
              className="rounded-md border border-slate-700 p-1.5 text-rose-300 transition hover:bg-slate-800"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          )}
        </div>
      ),
    }),
  ];

  const table = useReactTable({
    data: channelsQuery.data?.items ?? [],
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
          <h1 className="text-lg font-semibold text-slate-100">Live TV</h1>
          <p className="mt-1 text-sm text-slate-400">
            {total} {total === 1 ? 'channel' : 'channels'} configured.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            onClick={() => navigate('/live-tv/new')}
            className="flex items-center gap-1.5 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white"
          >
            <Plus size={14} aria-hidden />
            Add channel
          </button>
        )}
      </header>

      <div className="mb-4 flex items-end justify-between gap-4 border-b border-slate-800">
        <div role="tablist" className="flex gap-1">
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

        <div className="pb-2">
          <label htmlFor="category-filter" className="sr-only">
            Filter by category
          </label>
          <input
            id="category-filter"
            type="text"
            list="channel-categories"
            value={category}
            placeholder="Filter by category…"
            onChange={(event) => {
              setCategory(event.target.value);
              setPage(1);
            }}
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-slate-500"
          />
          <datalist id="channel-categories">
            {(categoriesQuery.data ?? []).map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}

      {channelsQuery.isError && (
        <p className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          Could not load live channels.
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-400">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} className="px-4 py-2.5 font-medium last:text-right">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-slate-800">
            {channelsQuery.isPending && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}

            {channelsQuery.isSuccess && table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-slate-400">
                  No live channels here yet.
                </td>
              </tr>
            )}

            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => navigate(`/live-tv/${row.original.id}`)}
                className="cursor-pointer text-slate-300 transition hover:bg-slate-900/60"
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="px-4 py-3"
                    // Action buttons navigate or open a dialog of their own; the
                    // row click would otherwise fire underneath them too.
                    onClick={
                      cell.column.id === 'actions'
                        ? (event) => event.stopPropagation()
                        : undefined
                    }
                  >
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

      <Modal
        open={pendingDelete !== null}
        title="Delete live channel"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleteMutation.isPending}
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
              className="rounded-md bg-rose-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-rose-400 disabled:opacity-40"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          Delete <span className="font-medium text-slate-100">{pendingDelete?.nameI18n.en}</span>?
          Its {pendingDelete?.sourceCount ?? 0} stream{' '}
          {pendingDelete?.sourceCount === 1 ? 'source' : 'sources'} will be removed with it. This
          cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

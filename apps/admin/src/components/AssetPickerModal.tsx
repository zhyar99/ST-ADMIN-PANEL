import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import type { AssetDto, MediaAssetKind } from '@streaming/shared';

import { KIND_LABELS, listAssets } from '../lib/assetsApi';
import Modal from './Modal';

const PAGE_SIZE = 12;

interface AssetPickerModalProps {
  open: boolean;
  kind: MediaAssetKind;
  onSelect: (asset: AssetDto) => void;
  onClose: () => void;
}

/**
 * Browses the media library filtered to one kind and hands back the chosen
 * asset. Uploading is deliberately not offered here — that lives on the Media
 * Library page, so there is one upload path to audit rather than several.
 */
export default function AssetPickerModal({
  open,
  kind,
  onSelect,
  onClose,
}: AssetPickerModalProps) {
  const [page, setPage] = useState(1);

  const assetsQuery = useQuery({
    queryKey: ['admin', 'assets', kind, page, 'picker'],
    queryFn: () => listAssets({ kind, page, limit: PAGE_SIZE }),
    enabled: open,
  });

  const total = assetsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = assetsQuery.data?.items ?? [];
  const isImageKind = kind !== 'SUBTITLE';

  function choose(asset: AssetDto) {
    onSelect(asset);
    onClose();
  }

  return (
    <Modal
      open={open}
      size="lg"
      title={`Choose ${KIND_LABELS[kind].toLowerCase().replace(/s$/, '')}`}
      description={`Showing ${KIND_LABELS[kind].toLowerCase()} from the media library.`}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between">
          <span className="text-xs text-slate-400">
            {total} {total === 1 ? 'item' : 'items'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
              className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-xs text-slate-400">
              {page} / {totalPages}
            </span>
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
      }
    >
      {assetsQuery.isPending && <p className="py-8 text-center text-sm text-slate-400">Loading…</p>}

      {assetsQuery.isError && (
        <p className="py-8 text-center text-sm text-rose-300">Could not load the media library.</p>
      )}

      {assetsQuery.isSuccess && items.length === 0 && (
        <p className="py-8 text-center text-sm text-slate-400">
          No {KIND_LABELS[kind].toLowerCase()} uploaded yet. Add some from the Media Library page.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map((asset) => (
          <button
            key={asset.id}
            type="button"
            onClick={() => choose(asset)}
            className="group overflow-hidden rounded-md border border-slate-800 bg-slate-950 text-left transition hover:border-slate-600"
          >
            {isImageKind ? (
              <img
                src={asset.url}
                alt=""
                loading="lazy"
                className="aspect-2/3 w-full object-cover"
              />
            ) : (
              <span className="flex aspect-2/3 w-full items-center justify-center text-slate-500">
                <FileText size={28} aria-hidden />
              </span>
            )}
            <span className="block truncate px-2 py-1.5 text-xs text-slate-400 group-hover:text-slate-200">
              {asset.url.slice(asset.url.lastIndexOf('/') + 1)}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileVideo, Image as ImageIcon, Subtitles, Trash2 } from 'lucide-react';
import type { AssetDto, MediaAssetKind } from '@streaming/shared';

import { ApiError } from '../lib/api';
import { useAuth } from '../lib/authContext';
import {
  ACCEPT_BY_KIND,
  ASSET_KINDS,
  KIND_LABELS,
  deleteAsset,
  listAssets,
  uploadAsset,
} from '../lib/assetsApi';

const PAGE_SIZE = 24;

/** `undefined` is the "All" tab. */
type KindFilter = MediaAssetKind | undefined;

const KIND_BADGE: Record<MediaAssetKind, string> = {
  POSTER: 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/30',
  BACKDROP: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  THUMBNAIL: 'bg-teal-500/15 text-teal-300 ring-teal-500/30',
  LOGO: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  SUBTITLE: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  AD_CREATIVE: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
};

/** Singular label for a badge, derived from the plural tab label. */
function badgeLabel(kind: MediaAssetKind): string {
  return KIND_LABELS[kind].replace(/s$/, '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function isPreviewable(asset: AssetDto): boolean {
  return asset.mimeType.startsWith('image/');
}

function assetsQueryKey(kind: KindFilter, page: number) {
  return ['admin', 'assets', kind ?? 'ALL', page] as const;
}

export default function MediaPage() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<KindFilter>(undefined);
  const [page, setPage] = useState(1);
  const [isUploadOpen, setUploadOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AssetDto | null>(null);

  const assetsQuery = useQuery({
    queryKey: assetsQueryKey(kind, page),
    queryFn: () => listAssets({ kind, page, limit: PAGE_SIZE }),
  });

  const canDelete = isAdmin();
  const totalPages = Math.max(1, Math.ceil((assetsQuery.data?.total ?? 0) / PAGE_SIZE));

  function invalidateAssets() {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'assets'] });
  }

  const removeAsset = useMutation({
    mutationFn: (asset: AssetDto) => deleteAsset(asset.id),
    onSuccess: () => {
      setActionError(null);
      setPendingDelete(null);
      invalidateAssets();
    },
    onError: (error) => {
      setPendingDelete(null);
      setActionError(
        error instanceof ApiError
          ? error.code === 'ASSET_IN_USE'
            ? `${error.message}. Detach it from that content before deleting.`
            : error.message
          : 'Could not delete the asset.',
      );
    },
  });

  function selectKind(next: KindFilter) {
    setKind(next);
    setPage(1);
  }

  const items = assetsQuery.data?.items ?? [];

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Media Library</h1>
          <p className="mt-1 text-sm text-slate-400">
            Posters, backdrops, thumbnails, logos, subtitles and ad creatives stored on this server.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          className="rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 transition hover:bg-white"
        >
          Upload
        </button>
      </div>

      <div className="mt-6 flex flex-wrap gap-1" role="tablist" aria-label="Filter by asset kind">
        <FilterTab label="All" isActive={kind === undefined} onSelect={() => selectKind(undefined)} />
        {ASSET_KINDS.map((value) => (
          <FilterTab
            key={value}
            label={KIND_LABELS[value]}
            isActive={kind === value}
            onSelect={() => selectKind(value)}
          />
        ))}
      </div>

      {actionError && (
        <p
          className="mt-4 rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-300"
          role="alert"
        >
          {actionError}
        </p>
      )}

      {assetsQuery.isError && (
        <p className="mt-6 text-sm text-rose-300">
          {assetsQuery.error instanceof ApiError
            ? assetsQuery.error.message
            : 'Could not load the media library.'}
        </p>
      )}

      {assetsQuery.isLoading && <p className="mt-6 text-sm text-slate-400">Loading assets…</p>}

      {!assetsQuery.isLoading && !assetsQuery.isError && items.length === 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-slate-800 px-6 py-12 text-center">
          <p className="text-sm text-slate-400">
            {kind ? `No ${KIND_LABELS[kind].toLowerCase()} yet.` : 'No assets uploaded yet.'}
          </p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              canDelete={canDelete}
              onDelete={() => {
                setActionError(null);
                setPendingDelete(asset);
              }}
            />
          ))}
        </ul>
      )}

      {(assetsQuery.data?.total ?? 0) > PAGE_SIZE && (
        <div className="mt-6 flex items-center justify-between text-sm text-slate-400">
          <span>
            Page {page} of {totalPages} · {assetsQuery.data?.total} assets
          </span>
          <div className="flex gap-2">
            <PagerButton disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
              Previous
            </PagerButton>
            <PagerButton
              disabled={!assetsQuery.data?.hasMore}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </PagerButton>
          </div>
        </div>
      )}

      {isUploadOpen && (
        <UploadDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            setActionError(null);
            setPage(1);
            invalidateAssets();
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDeleteDialog
          asset={pendingDelete}
          isPending={removeAsset.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => removeAsset.mutate(pendingDelete)}
        />
      )}
    </div>
  );
}

function FilterTab({
  label,
  isActive,
  onSelect,
}: {
  label: string;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onSelect}
      className={`rounded-md px-3 py-1.5 text-sm transition ${
        isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
      }`}
    >
      {label}
    </button>
  );
}

function PagerButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-slate-700 px-2.5 py-1 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function KindIcon({ kind }: { kind: MediaAssetKind }) {
  if (kind === 'SUBTITLE') return <Subtitles size={28} aria-hidden />;
  if (kind === 'AD_CREATIVE') return <FileVideo size={28} aria-hidden />;
  return <ImageIcon size={28} aria-hidden />;
}

function AssetCard({
  asset,
  canDelete,
  onDelete,
}: {
  asset: AssetDto;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <li className="group overflow-hidden rounded-lg border border-slate-800 bg-slate-900/40">
      <div className="relative flex h-32 items-center justify-center bg-slate-950">
        {isPreviewable(asset) ? (
          <img
            src={asset.url}
            alt=""
            loading="lazy"
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-slate-600">
            <KindIcon kind={asset.kind} />
          </span>
        )}

        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${badgeLabel(asset.kind).toLowerCase()}`}
            className="absolute right-1.5 top-1.5 rounded-md bg-slate-950/80 p-1.5 text-slate-400 opacity-0 transition hover:text-rose-300 focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 size={14} aria-hidden />
          </button>
        )}
      </div>

      <div className="space-y-1.5 p-3">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
            KIND_BADGE[asset.kind]
          }`}
        >
          {badgeLabel(asset.kind)}
        </span>
        <p className="truncate text-sm text-slate-200" title={asset.name}>
          {asset.name}
        </p>
        <p className="text-xs text-slate-400">
          {formatBytes(asset.sizeBytes)}
          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
        </p>
        <p className="text-xs text-slate-500">{formatDate(asset.createdAt)}</p>
      </div>
    </li>
  );
}

function UploadDialog({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const [kind, setKind] = useState<MediaAssetKind>('POSTER');
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (input: { kind: MediaAssetKind; file: File; name?: string }) =>
      uploadAsset(input.kind, input.file, input.name),
    onSuccess: onUploaded,
    onError: (uploadError) => {
      setError(
        uploadError instanceof ApiError ? uploadError.message : 'Could not upload the file.',
      );
    },
  });

  // The accept list changes with the kind, so a file chosen for the previous
  // kind must not silently survive the switch.
  useEffect(() => {
    setFile(null);
    setName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [kind]);

  const fieldClass =
    'mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-asset-title"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h2 id="upload-asset-title" className="text-lg font-semibold text-slate-100">
          Upload Asset
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          The server re-checks the type, size and image dimensions before storing anything.
        </p>

        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (!file) {
              setError('Choose a file to upload.');
              return;
            }
            if (kind === 'SUBTITLE' && !name.trim()) {
              setError('Enter a name for this subtitle.');
              return;
            }
            upload.mutate({ kind, file, ...(kind === 'SUBTITLE' && { name: name.trim() }) });
          }}
        >
          <div>
            <label htmlFor="upload-kind" className="block text-sm font-medium text-slate-300">
              Kind
            </label>
            <select
              id="upload-kind"
              className={fieldClass}
              value={kind}
              onChange={(event) => setKind(event.target.value as MediaAssetKind)}
            >
              {ASSET_KINDS.map((value) => (
                <option key={value} value={value}>
                  {badgeLabel(value)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="upload-file" className="block text-sm font-medium text-slate-300">
              File
            </label>
            <input
              id="upload-file"
              ref={fileInputRef}
              type="file"
              required
              accept={ACCEPT_BY_KIND[kind]}
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setFile(selected);
                if (kind === 'SUBTITLE' && selected && !name.trim()) {
                  setName(selected.name.replace(/\.[^.]+$/, ''));
                }
              }}
              className={`${fieldClass} file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-slate-200`}
            />
          </div>

          {kind === 'SUBTITLE' && (
            <div>
              <label htmlFor="upload-subtitle-name" className="block text-sm font-medium text-slate-300">
                Subtitle name
              </label>
              <input
                id="upload-subtitle-name"
                type="text"
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Movie title – English"
                className={fieldClass}
              />
              <p className="mt-1 text-xs text-slate-500">
                This name is shown in the media library and subtitle picker.
              </p>
            </div>
          )}

          {error && (
            <p
              className="rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-300"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={upload.isPending}
              className="rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {upload.isPending ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ConfirmDeleteDialog({
  asset,
  isPending,
  onCancel,
  onConfirm,
}: {
  asset: AssetDto;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-asset-title"
    >
      <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <h2 id="delete-asset-title" className="text-lg font-semibold text-slate-100">
          Delete this {badgeLabel(asset.kind).toLowerCase()}?
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          The file is removed from the server. Assets still attached to content cannot be deleted.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={onConfirm}
            className="rounded-md bg-rose-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

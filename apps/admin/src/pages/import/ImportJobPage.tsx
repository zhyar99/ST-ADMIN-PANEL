import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Link2, Loader2, Search, X } from 'lucide-react';
import type { ImportEntryDto, ImportEntryStatus } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import {
  approveEntry,
  bulkApproveEntries,
  catalogPathFor,
  getImportJob,
  listImportEntries,
  listLinkTargets,
  rejectEntry,
  type ImportTargetType,
} from '../../lib/importApi';
import SelectionCheckbox from '../../components/SelectionCheckbox';
import Modal from '../../components/Modal';
import StatusBadge from '../../components/StatusBadge';
import { EntryStatusBadge, JobStatusBadge } from './ImportBadges';

/**
 * The review queue for one uploaded playlist.
 *
 * Every action on this page is one reviewer decision about one line of a file
 * the platform did not write. Nothing here edits catalogue content: approving
 * creates a draft stub or attaches a fallback source, and the reviewer then
 * goes to Live TV or Movies to finish the job.
 */

const PAGE_SIZE = 50;

/** `undefined` is the "All" tab. */
type StatusFilter = ImportEntryStatus | undefined;

const STATUS_TABS: ReadonlyArray<{ label: string; value: StatusFilter }> = [
  { label: 'All', value: undefined },
  { label: 'Staged', value: 'STAGED' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Rejected', value: 'REJECTED' },
  { label: 'Duplicate', value: 'DUPLICATE' },
];

const TYPE_LABELS: Record<ImportTargetType, string> = {
  LIVE_CHANNEL: 'Live channel',
  MOVIE: 'Movie',
};

const FIELD_CLASS =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-slate-500';

const SMALL_BUTTON =
  'rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40';

export default function ImportJobPage() {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const canManage = isAdmin();

  const [status, setStatus] = useState<StatusFilter>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Per-row target type. Absent means the default, a live channel. */
  const [typeByEntry, setTypeByEntry] = useState<Record<string, ImportTargetType>>({});
  const [linking, setLinking] = useState<ImportEntryDto | null>(null);
  const [rejecting, setRejecting] = useState<ImportEntryDto | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [bulkType, setBulkType] = useState<ImportTargetType | null>(null);
  const [bulkIds, setBulkIds] = useState<string[] | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const cursor = cursorStack.at(-1);

  const jobQuery = useQuery({
    queryKey: ['admin', 'import', 'job', jobId],
    queryFn: () => getImportJob(jobId),
    enabled: jobId !== '',
  });

  const entriesQuery = useQuery({
    queryKey: ['admin', 'import', 'entries', jobId, status ?? 'ALL', cursor ?? 'FIRST'],
    queryFn: () => listImportEntries(jobId, { status, cursor, limit: PAGE_SIZE }),
    enabled: jobId !== '',
    placeholderData: keepPreviousData,
  });

  function refresh() {
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'import', 'job', jobId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'import', 'entries', jobId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'import', 'jobs'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'live-channels'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'movies'] });
  }

  function reportFailure(fallback: string) {
    return (cause: unknown) => setError(cause instanceof ApiError ? cause.message : fallback);
  }

  const approve = useMutation({
    mutationFn: (input: { entryId: string; type: ImportTargetType; targetId?: string }) =>
      approveEntry(jobId, input.entryId, {
        mappedType: input.type,
        ...(input.targetId ? { targetId: input.targetId } : { createNew: true }),
      }),
    onSuccess: (entry) => {
      setSelected((current) => new Set([...current].filter((id) => id !== entry.id)));
      setLinking(null);
      refresh();
    },
    onError: reportFailure('Could not approve that entry.'),
  });

  const reject = useMutation({
    mutationFn: (input: { entryId: string; note?: string }) =>
      rejectEntry(jobId, input.entryId, input.note),
    onSuccess: (entry) => {
      setSelected((current) => new Set([...current].filter((id) => id !== entry.id)));
      setRejecting(null);
      setRejectNote('');
      refresh();
    },
    onError: reportFailure('Could not reject that entry.'),
  });

  const bulkApprove = useMutation({
    mutationFn: (type: ImportTargetType) => bulkApproveEntries(jobId, type, bulkIds),
    onSuccess: (result) => {
      setSelected(new Set());
      setNotice(`${result.approved} entries approved. ${result.skipped} skipped.`);
      setBulkType(null);
      // Back to the first page: the rows that were on screen have all moved out
      // of the Staged tab.
      setCursorStack([]);
      refresh();
    },
    onError: (cause) => {
      setBulkType(null);
      reportFailure('Could not bulk-approve this job.')(cause);
    },
  });

  const job = jobQuery.data;
  const entries = entriesQuery.data?.items ?? [];
  const stagedCount = job?.entryCounts.STAGED ?? 0;
  const busy = approve.isPending || reject.isPending || bulkApprove.isPending;

  const selectable = entries.filter((entry) => entry.status === 'STAGED');
  const allOnPage = selectable.length > 0 && selectable.every((entry) => selected.has(entry.id));
  function toggleEntry(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 1000) next.add(id);
      return next;
    });
  }
  function togglePage() {
    setSelected((current) => {
      const next = new Set(current);
      for (const entry of selectable) {
        if (allOnPage) next.delete(entry.id);
        else if (next.size < 1000) next.add(entry.id);
      }
      return next;
    });
  }

  function typeFor(entryId: string): ImportTargetType {
    return typeByEntry[entryId] ?? 'LIVE_CHANNEL';
  }

  function selectStatus(next: StatusFilter) {
    setSelected(new Set());
    setStatus(next);
    setCursorStack([]);
  }

  if (jobQuery.isError) {
    return (
      <div className="p-6">
        <p className="text-sm text-rose-300">That import job could not be loaded.</p>
        <Link to="/import" className="mt-3 inline-block text-sm text-slate-300 hover:underline">
          Back to imports
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6">
      <button
        type="button"
        onClick={() => navigate('/import')}
        className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-slate-200"
      >
        <ArrowLeft size={14} aria-hidden />
        All imports
      </button>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            {job?.filename ?? 'Import'}
            {job && <JobStatusBadge status={job.status} />}
          </h1>
          {job && (
            <p className="mt-1 text-sm text-slate-400">
              {job.totalEntries} {job.totalEntries === 1 ? 'entry' : 'entries'} ·{' '}
              {job.entryCounts.STAGED} staged · {job.entryCounts.APPROVED} approved ·{' '}
              {job.entryCounts.REJECTED} rejected · {job.entryCounts.DUPLICATE} duplicate
            </p>
          )}
          {job?.errorMessage && (
            <p className="mt-1 text-sm text-rose-300" role="alert">
              {job.errorMessage}
            </p>
          )}
        </div>

        {canManage && stagedCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
            <span className="text-xs text-slate-400">
              {stagedCount} staged {stagedCount === 1 ? 'entry' : 'entries'}:
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setBulkIds(undefined); setBulkType('LIVE_CHANNEL'); }}
              className={SMALL_BUTTON}
            >
              Approve all as live channels
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setBulkIds(undefined); setBulkType('MOVIE'); }}
              className={SMALL_BUTTON}
            >
              Approve all as movies
            </button>
          </div>
        )}
      </header>

      {error && (
        <p className="mb-4 text-sm text-rose-300" role="alert">
          {error}
        </p>
      )}

      {notice && <p role="status" className="mb-4 text-sm text-emerald-300">{notice}</p>}
      {canManage && selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
          <span className="text-sm text-sky-100">{selected.size} selected across pages (up to 1,000)</span>
          <button type="button" disabled={busy} className={SMALL_BUTTON}
            onClick={() => { setBulkIds([...selected]); setBulkType('LIVE_CHANNEL'); }}>Accept selected as live channels</button>
          <button type="button" disabled={busy} className={SMALL_BUTTON}
            onClick={() => { setBulkIds([...selected]); setBulkType('MOVIE'); }}>Accept selected as movies</button>
          <button type="button" disabled={busy} className={SMALL_BUTTON}
            onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      {entriesQuery.isError && <p role="alert" className="mb-4 text-sm text-rose-300">Could not load entries.</p>}

      <div className="mb-4 border-b border-slate-800" role="tablist">
        <div className="flex gap-1">
          {STATUS_TABS.map((tab) => {
            const isActive = tab.value === status;
            const tally = tab.value && job ? job.entryCounts[tab.value] : null;

            return (
              <button
                key={tab.label}
                type="button"
                role="tab"
                aria-selected={isActive}
                disabled={busy}
                onClick={() => selectStatus(tab.value)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
                  isActive
                    ? 'border-slate-200 text-slate-100'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
                {tally !== null && <span className="ml-1.5 text-xs text-slate-500">{tally}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              {canManage && <th className="px-3 py-2.5"><SelectionCheckbox
                aria-label="Select all staged entries on this page" checked={allOnPage}
                indeterminate={!allOnPage && selectable.some((entry) => selected.has(entry.id))}
                disabled={busy || entriesQuery.isFetching || selectable.length === 0} onChange={togglePage} /></th>}
              <th className="px-3 py-2.5 font-medium">Line</th>
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Group</th>
              {/* The URL column is present only for an ADMIN; the server omits
                  the field entirely for a VIEWER, so there is nothing to show. */}
              {canManage && <th className="px-3 py-2.5 font-medium">URL</th>}
              <th className="px-3 py-2.5 font-medium">Import as</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {entriesQuery.isPending && (
              <tr>
                <td colSpan={canManage ? 8 : 6} className="px-4 py-6 text-center text-slate-400">
                  Loading entries…
                </td>
              </tr>
            )}

            {!entriesQuery.isPending && entries.length === 0 && (
              <tr>
                <td colSpan={canManage ? 8 : 6} className="px-4 py-10 text-center text-slate-400">
                  Nothing here.
                </td>
              </tr>
            )}

            {entries.map((entry) => {
              const isStaged = entry.status === 'STAGED';
              const owner = entry.duplicateOwner;
              const ownerPath = owner ? catalogPathFor(owner) : null;

              return (
                <tr key={entry.id} className="align-top hover:bg-slate-900/40">
                  {canManage && <td className="px-3 py-2.5"><SelectionCheckbox
                    aria-label={`Select ${entry.rawName ?? `line ${entry.lineNumber}`}`}
                    checked={selected.has(entry.id)} onChange={() => toggleEntry(entry.id)}
                    disabled={!isStaged || busy || entriesQuery.isFetching || (!selected.has(entry.id) && selected.size >= 1000)} /></td>}
                  <td className="px-3 py-2.5 text-slate-500">{entry.lineNumber}</td>
                  <td className="px-3 py-2.5">
                    <span className="font-medium text-slate-100">
                      {entry.rawName ?? <span className="text-slate-500">(no name)</span>}
                    </span>
                    {entry.adminNote && (
                      <p className="mt-0.5 text-xs text-amber-300/80">{entry.adminNote}</p>
                    )}
                    {entry.duplicateOf && (
                      <p className="mt-0.5 text-xs text-amber-300/80">
                        This URL is already a source
                        {ownerPath ? (
                          <>
                            {' on '}
                            <Link to={ownerPath} className="underline underline-offset-2">
                              an existing item
                            </Link>
                            .
                          </>
                        ) : (
                          ' in the catalogue.'
                        )}
                      </p>
                    )}
                    {entry.mappedId && (
                      <p className="mt-0.5 text-xs text-slate-500">
                        <Link
                          to={
                            catalogPathFor({ type: entry.mappedType, id: entry.mappedId }) ??
                            '/import'
                          }
                          className="underline underline-offset-2"
                        >
                          Open the {TYPE_LABELS[entry.mappedType as ImportTargetType] ?? 'item'} it
                          created
                        </Link>
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-slate-400">{entry.rawGroup ?? '—'}</td>
                  {canManage && (
                    <td className="max-w-xs px-3 py-2.5">
                      <span
                        className="block truncate font-mono text-xs text-slate-500"
                        title={entry.rawUrl}
                      >
                        {entry.rawUrl}
                      </span>
                    </td>
                  )}
                  <td className="px-3 py-2.5">
                    {isStaged && canManage ? (
                      <select
                        aria-label={`Import ${entry.rawName ?? `line ${entry.lineNumber}`} as`}
                        value={typeFor(entry.id)}
                        onChange={(event) =>
                          setTypeByEntry((current) => ({
                            ...current,
                            [entry.id]: event.target.value as ImportTargetType,
                          }))
                        }
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 outline-none focus:border-slate-500"
                      >
                        <option value="LIVE_CHANNEL">Live channel</option>
                        <option value="MOVIE">Movie</option>
                      </select>
                    ) : (
                      <span className="text-xs text-slate-500">
                        {TYPE_LABELS[entry.mappedType as ImportTargetType] ?? '—'}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <EntryStatusBadge status={entry.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    {canManage && (
                      <div className="flex justify-end gap-1.5">
                        {isStaged && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                approve.mutate({ entryId: entry.id, type: typeFor(entry.id) })
                              }
                              className={SMALL_BUTTON}
                            >
                              <Check size={12} aria-hidden className="mr-1 inline" />
                              Approve as new
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setLinking(entry)}
                              className={SMALL_BUTTON}
                            >
                              <Link2 size={12} aria-hidden className="mr-1 inline" />
                              Link…
                            </button>
                          </>
                        )}
                        {entry.status !== 'APPROVED' && entry.status !== 'REJECTED' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setRejecting(entry);
                              setRejectNote('');
                            }}
                            className={SMALL_BUTTON}
                          >
                            <X size={12} aria-hidden className="mr-1 inline" />
                            Reject
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={busy || entriesQuery.isFetching || cursorStack.length === 0}
          onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={busy || entriesQuery.isFetching || !entriesQuery.data?.nextCursor}
          onClick={() => {
            const next = entriesQuery.data?.nextCursor;
            if (next) setCursorStack((stack) => [...stack, next]);
          }}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>

      {linking && (
        <LinkTargetPicker
          type={typeFor(linking.id)}
          entryName={linking.rawName ?? `line ${linking.lineNumber}`}
          pending={approve.isPending}
          onClose={() => setLinking(null)}
          onPick={(targetId) =>
            approve.mutate({ entryId: linking.id, type: typeFor(linking.id), targetId })
          }
        />
      )}

      <Modal
        open={rejecting !== null}
        title="Reject this entry?"
        description="It stays in the list, marked rejected, so the same playlist can be reviewed again later."
        onClose={() => setRejecting(null)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setRejecting(null)}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={reject.isPending}
              onClick={() =>
                rejecting &&
                reject.mutate({ entryId: rejecting.id, note: rejectNote.trim() || undefined })
              }
              className="rounded-md bg-rose-500/90 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-rose-500 disabled:opacity-50"
            >
              Reject
            </button>
          </>
        }
      >
        <label htmlFor="reject-note" className="mb-1.5 block text-sm text-slate-300">
          Note (optional)
        </label>
        <input
          id="reject-note"
          type="text"
          maxLength={500}
          value={rejectNote}
          placeholder="Why this one is not wanted…"
          onChange={(event) => setRejectNote(event.target.value)}
          className={FIELD_CLASS}
        />
      </Modal>

      <Modal
        open={bulkType !== null}
        title={
          `Accept ${bulkIds ? `${bulkIds.length} selected entries` : 'all staged entries'} as ${bulkType === 'MOVIE' ? 'movies' : 'live channels'}?`
        }
        description="Each staged entry becomes a draft with the playlist name and one stream source. Duplicates are skipped."
        onClose={() => { if (!bulkApprove.isPending) setBulkType(null); }}
        footer={
          <>
            <button
              type="button"
              disabled={bulkApprove.isPending}
              onClick={() => setBulkType(null)}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={bulkApprove.isPending}
              onClick={() => bulkType && bulkApprove.mutate(bulkType)}
              className="flex items-center gap-1.5 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-50"
            >
              {bulkApprove.isPending && (
                <Loader2 size={14} aria-hidden className="animate-spin" />
              )}
              Accept {bulkIds?.length ?? stagedCount}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          The drafts arrive with no artwork and the playlist name in all three languages. Fill those
          in from{' '}
          {bulkType === 'MOVIE' ? (
            <Link to="/movies" className="underline underline-offset-2">
              Movies
            </Link>
          ) : (
            <Link to="/live-tv" className="underline underline-offset-2">
              Live TV
            </Link>
          )}{' '}
          before publishing.
        </p>
      </Modal>
    </div>
  );
}

/**
 * Search-and-select for an existing catalogue item.
 *
 * Searches drafts as well as published rows — the item a reviewer wants to
 * attach a fallback source to is often a stub from an earlier import — and
 * shows how many sources each already has, because the new one is appended to
 * the end of that chain rather than becoming the primary.
 */
function LinkTargetPicker({
  type,
  entryName,
  pending,
  onClose,
  onPick,
}: {
  type: ImportTargetType;
  entryName: string;
  pending: boolean;
  onClose: () => void;
  onPick: (targetId: string) => void;
}) {
  const [term, setTerm] = useState('');

  const targetsQuery = useQuery({
    queryKey: ['admin', 'import', 'link-targets', type, term],
    queryFn: () => listLinkTargets({ type, q: term || undefined, limit: 20 }),
    placeholderData: keepPreviousData,
  });

  const targets = targetsQuery.data ?? [];

  return (
    <Modal
      open
      size="lg"
      title={`Attach "${entryName}" to an existing ${TYPE_LABELS[type].toLowerCase()}`}
      description="The playlist URL is added as an extra fallback source. The item's current primary source keeps its place."
      onClose={onClose}
    >
      <div className="relative mb-3">
        <Search
          size={14}
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
        />
        <input
          type="search"
          autoFocus
          value={term}
          placeholder={`Search ${TYPE_LABELS[type].toLowerCase()}s by English name…`}
          onChange={(event) => setTerm(event.target.value)}
          className={`${FIELD_CLASS} pl-8`}
        />
      </div>

      {targetsQuery.isPending && <p className="text-sm text-slate-400">Searching…</p>}

      {!targetsQuery.isPending && targets.length === 0 && (
        <p className="text-sm text-slate-400">Nothing matches that.</p>
      )}

      <ul className="divide-y divide-slate-800">
        {targets.map((target) => (
          <li key={target.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-slate-100">{target.name}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {target.sourceCount} {target.sourceCount === 1 ? 'source' : 'sources'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusBadge status={target.status} />
              <button
                type="button"
                disabled={pending}
                onClick={() => onPick(target.id)}
                className={SMALL_BUTTON}
              >
                Attach
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

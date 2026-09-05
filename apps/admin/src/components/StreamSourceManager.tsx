import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { StreamSourceDto } from '@streaming/shared';

import { ApiError } from '../lib/api';
import { useAuth } from '../lib/authContext';
import type { StreamTestOutcome } from '../lib/catalogApi';
import Modal from './Modal';
import StreamSourceRow from './StreamSourceRow';

/**
 * The stream source list, owner-agnostic.
 *
 * Every owner type talks to the same endpoint shape under a different prefix,
 * so the behaviour is injected as a small adapter rather than duplicated per
 * page. Phase 12 finished the consolidation this comment used to ask for:
 * `movies/StreamSourcesSection` and `series/EpisodeSourcesSection` were
 * hand-written copies of this UI and are now thin wrappers around it, so the
 * three pages cannot drift apart again.
 *
 * The URL is never rendered in the table. It is fetched on demand through the
 * audited /url endpoint and shown in a modal, so browsing the catalogue does
 * not scatter playable URLs through the DOM.
 */

/** The owner-specific half of the source API. */
export interface StreamSourceApi {
  list: () => Promise<StreamSourceDto[]>;
  add: (url: string) => Promise<StreamSourceDto>;
  remove: (sourceId: string) => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<StreamSourceDto[]>;
  test: (sourceId: string) => Promise<StreamTestOutcome>;
  revealUrl: (sourceId: string) => Promise<string>;
}

interface StreamSourceManagerProps {
  /** TanStack Query key for this owner's source list. */
  queryKey: readonly unknown[];
  api: StreamSourceApi;
  /** Placeholder for the add-source input. */
  urlPlaceholder?: string;
}

/** Client-side URL check, mirroring the server's. Purely to fail fast. */
function isValidUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

export default function StreamSourceManager({
  queryKey,
  api,
  urlPlaceholder = 'https://server.example/live/test/master.m3u8',
}: StreamSourceManagerProps) {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const canManage = isAdmin();

  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StreamSourceDto | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const sourcesQuery = useQuery({
    queryKey,
    queryFn: api.list,
    // A VIEWER gets a 403 from this endpoint by design; asking would just
    // produce a permanent error banner on the page.
    enabled: canManage,
  });

  const sources = sourcesQuery.data ?? [];

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey });
  }

  function reportError(cause: unknown) {
    setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Try again.');
  }

  const addMutation = useMutation({
    mutationFn: () => api.add(url.trim()),
    onSuccess: () => {
      setUrl('');
      setError(null);
      invalidate();
    },
    onError: reportError,
  });

  const deleteMutation = useMutation({
    mutationFn: api.remove,
    onSuccess: () => {
      setPendingDelete(null);
      invalidate();
    },
    onError: (cause) => {
      setPendingDelete(null);
      reportError(cause);
    },
  });

  const reorderMutation = useMutation({
    mutationFn: api.reorder,
    onSuccess: invalidate,
    onError: reportError,
  });

  const testMutation = useMutation({
    mutationFn: api.test,
    onSuccess: (outcome, sourceId) => {
      setError(outcome.result === 'FAILED' ? `Test failed: ${outcome.reason}` : null);
      invalidate();
      // The check just run belongs in the history popover too, whether or not
      // it is open right now.
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'stream-sources', sourceId, 'health-history'],
      });
    },
    onError: reportError,
    onSettled: () => setTestingId(null),
  });

  const revealMutation = useMutation({
    mutationFn: api.revealUrl,
    onSuccess: setRevealed,
    onError: reportError,
  });

  /** Swaps a source with its neighbour and pushes the whole new order. */
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= sources.length) return;

    const ordered = sources.map((source) => source.id);
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];

    reorderMutation.mutate(ordered);
  }

  if (!canManage) {
    return <p className="text-sm text-slate-400">Stream sources are only visible to administrators.</p>;
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">Priority</th>
              <th className="px-4 py-2.5 font-medium">Health</th>
              <th className="px-4 py-2.5 font-medium">Last tested</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {sourcesQuery.isPending && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}

            {sourcesQuery.isSuccess && sources.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  No stream sources yet. Add the primary one below.
                </td>
              </tr>
            )}

            {sources.map((source, index) => (
              <StreamSourceRow
                key={source.id}
                source={source}
                index={index}
                isLast={index === sources.length - 1}
                isTesting={testingId === source.id}
                isReordering={reorderMutation.isPending}
                onMove={(direction) => move(index, direction)}
                onTest={() => {
                  setTestingId(source.id);
                  testMutation.mutate(source.id);
                }}
                onRevealUrl={() => revealMutation.mutate(source.id)}
                onDelete={() => setPendingDelete(source)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          addMutation.mutate();
        }}
      >
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={urlPlaceholder}
          aria-label="Stream source URL"
          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
        />
        <button
          type="submit"
          disabled={!isValidUrl(url) || addMutation.isPending}
          className="flex items-center gap-1.5 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-40"
        >
          <Plus size={14} aria-hidden />
          {addMutation.isPending ? 'Adding…' : 'Add source'}
        </button>
      </form>
      <p className="mt-1.5 text-xs text-slate-500">
        New sources are appended as backups. Use the arrows to change which one is primary.
      </p>

      <Modal
        open={revealed !== null}
        title="Stream source URL"
        description="This access has been recorded in the audit log."
        onClose={() => setRevealed(null)}
      >
        {/*
          `select-none` is a friction hint that discourages casual copying — it
          is NOT a security control. Anyone who can open this modal can already
          read the URL from the network tab. The actual controls are the ADMIN
          role check and the audit_log entry, both server-side.
        */}
        <p className="break-all rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 select-none">
          {revealed}
        </p>
      </Modal>

      <Modal
        open={pendingDelete !== null}
        title="Delete stream source"
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
          Remove this stream source? The remaining sources will be renumbered.
        </p>
      </Modal>
    </div>
  );
}

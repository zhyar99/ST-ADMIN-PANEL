import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ShieldOff } from 'lucide-react';
import type { DeviceHistoryItem, ScoredRecommendationItem } from '@streaming/shared';

import Modal from '../../components/Modal';
import { useAuth } from '../../lib/authContext';
import {
  getDeviceDetail,
  previewDeviceRecommendations,
  setDeviceBlocked,
} from '../../lib/analyticsApi';
import { analyticsKeys } from './analyticsKeys';
import StatTile from './StatTile';

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** At most this many genres are rendered; the vector itself caps at 50. */
const MAX_AFFINITY_PILLS = 20;

/** Turns `because_you_like_Drama` into something readable. */
function readableReason(reason: string): string {
  if (reason.startsWith('because_you_like_')) {
    return `Likes ${reason.slice('because_you_like_'.length)}`;
  }
  return reason.replaceAll('_', ' ');
}

function HistoryRow({ event }: { event: DeviceHistoryItem }) {
  return (
    <tr className="hover:bg-slate-900/40">
      <td className="px-3 py-2 font-medium text-slate-100">{event.title}</td>
      <td className="px-3 py-2 text-slate-400">{event.content_type}</td>
      <td className="px-3 py-2 tabular-nums">{Math.round(event.completion_rate * 100)}%</td>
      <td className="px-3 py-2 tabular-nums">
        {Math.round(event.watch_seconds / 60)}m of {Math.round(event.content_seconds / 60)}m
      </td>
      <td className="px-3 py-2 text-slate-400">{formatDateTime(event.started_at)}</td>
    </tr>
  );
}

/**
 * One device's profile (Phase 15).
 *
 * ADMIN-only, and the reason is worth being explicit about: a device id plus
 * this page is a household's viewing history. There is no name attached, but
 * there is a pattern of behaviour, and a VIEWER has no operational reason to
 * read one — so a VIEWER who reaches this route is sent back to the section
 * index rather than shown a 403 shell.
 */
export default function DeviceDetailPage() {
  const { deviceId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();

  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const [previewRequested, setPreviewRequested] = useState(false);

  const device = useQuery({
    queryKey: analyticsKeys.device(deviceId),
    queryFn: () => getDeviceDetail(deviceId),
    enabled: isAdmin() && deviceId !== '',
  });

  const preview = useQuery({
    queryKey: analyticsKeys.devicePreview(deviceId),
    queryFn: () => previewDeviceRecommendations(deviceId, 10),
    enabled: isAdmin() && previewRequested,
  });

  const block = useMutation({
    mutationFn: (next: boolean) => setDeviceBlocked(deviceId, next),
    onSuccess: async () => {
      setConfirmingBlock(false);
      await queryClient.invalidateQueries({ queryKey: analyticsKeys.device(deviceId) });
      await queryClient.invalidateQueries({ queryKey: analyticsKeys.devicePreview(deviceId) });
    },
  });

  // The server refuses a VIEWER too; the redirect only avoids rendering a page
  // that would be nothing but an error.
  if (!isAdmin()) {
    return <Navigate to="/analytics" replace state={{ notice: 'Admin access required.' }} />;
  }

  const profile = device.data;
  const affinity = (profile?.genre_affinity ?? []).slice(0, MAX_AFFINITY_PILLS);

  return (
    <div className="p-6">
      <button
        type="button"
        onClick={() => navigate('/analytics')}
        className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-slate-200"
      >
        <ArrowLeft size={14} aria-hidden />
        Analytics
      </button>

      {device.isError && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          No such device, or it has never contacted the platform.
        </p>
      )}

      {profile && (
        <>
          <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-mono text-sm text-slate-100">{profile.id}</h1>
              <p className="mt-1 text-sm text-slate-400">
                First seen {formatDateTime(profile.first_seen_at)} · last seen{' '}
                {formatDateTime(profile.last_seen_at)}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setConfirmingBlock(true)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                profile.is_blocked
                  ? 'bg-slate-100 text-slate-900 hover:bg-white'
                  : 'border border-red-900/60 text-red-300 hover:bg-red-950/40'
              }`}
            >
              <ShieldOff size={14} aria-hidden />
              {profile.is_blocked ? 'Unblock device' : 'Block device'}
            </button>
          </header>

          <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Watch hours" value={profile.total_watch_hours} />
            <StatTile label="Favourites" value={profile.favorites_count} />
            <StatTile label="Watchlist" value={profile.watchlist_count} />
            <StatTile
              label="Personalization"
              value={profile.is_blocked ? 'Blocked' : 'Active'}
              hint={profile.is_blocked ? 'Receives global ranking only' : undefined}
            />
          </div>

          <section className="mb-6 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
            <h2 className="text-sm font-semibold text-slate-100">Genre affinity</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Normalised so the strongest genre is 1.0. Top {MAX_AFFINITY_PILLS}.
            </p>

            <ul className="mt-4 flex flex-wrap gap-2">
              {affinity.map((entry) => (
                <li
                  key={entry.genre_id}
                  className="relative overflow-hidden rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-200"
                >
                  <span
                    className="absolute inset-y-0 left-0 bg-sky-500/25"
                    style={{ width: `${entry.score * 100}%` }}
                    aria-hidden
                  />
                  <span className="relative">
                    {entry.genre_name}
                    <span className="ml-1.5 tabular-nums text-slate-400">
                      {entry.score.toFixed(2)}
                    </span>
                  </span>
                </li>
              ))}
              {affinity.length === 0 && (
                <li className="text-xs text-slate-500">
                  No affinity yet — this device has not finished anything with a genre.
                </li>
              )}
            </ul>
          </section>

          <section className="mb-6">
            <h2 className="mb-3 text-sm font-semibold text-slate-100">Recent watch history</h2>
            <div className="overflow-hidden rounded-lg border border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Content</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Completion</th>
                    <th className="px-3 py-2 font-medium">Watched</th>
                    <th className="px-3 py-2 font-medium">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-300">
                  {profile.recent_watch_events.map((event) => (
                    <HistoryRow key={`${event.content_id}:${event.started_at}`} event={event} />
                  ))}
                  {profile.recent_watch_events.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-sm text-slate-500">
                        This device has not reported any viewing.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">Preview recommendations</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Exactly what this device would be served right now, with the scoring shown.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewRequested(true)}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 hover:text-white"
              >
                See what this device gets recommended
              </button>
            </div>

            {preview.data && (
              <>
                {preview.data.cold_start && (
                  <p className="mt-3 text-xs text-amber-300">
                    Cold start — ranked by platform popularity and freshness only.
                  </p>
                )}

                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {preview.data.items.map((item: ScoredRecommendationItem) => (
                    <li
                      key={`${item.content_type}:${item.content_id}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-slate-800 px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-slate-100">{item.title}</span>
                        <span className="text-xs text-slate-500">
                          {readableReason(item.reason)}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 text-xs tabular-nums text-slate-300">
                        {item.score.toFixed(3)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}

      <Modal
        open={confirmingBlock}
        title={profile?.is_blocked ? 'Unblock this device?' : 'Block this device?'}
        description={
          profile?.is_blocked
            ? 'It will be ranked on its own viewing history again.'
            : 'It keeps recording viewing, but is ranked as if it had none. The device is not told.'
        }
        onClose={() => setConfirmingBlock(false)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmingBlock(false)}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={block.isPending}
              onClick={() => block.mutate(!profile?.is_blocked)}
              className="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-50"
            >
              {profile?.is_blocked ? 'Unblock' : 'Block'}
            </button>
          </>
        }
      >
        <p className="font-mono text-xs text-slate-400">{profile?.id}</p>
      </Modal>
    </div>
  );
}

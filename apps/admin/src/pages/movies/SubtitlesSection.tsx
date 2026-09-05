import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Link2, Plus, Trash2 } from 'lucide-react';
import type { AssetDto, SubtitleLanguage, SubtitleTrackDto } from '@streaming/shared';
import { SUBTITLE_LANGUAGES } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { addSubtitle, deleteSubtitle, listSubtitles } from '../../lib/catalogApi';
import AssetPickerModal from '../../components/AssetPickerModal';
import Modal from '../../components/Modal';

const LANGUAGE_LABELS: Record<SubtitleLanguage, string> = {
  en: 'English',
  ar: 'Arabic',
  ckb: 'Kurdish Sorani',
};

/** Which of the two mutually exclusive sources the add form is using. */
type SourceMode = 'library' | 'external';

function fileNameOf(asset: AssetDto): string {
  return asset.url.slice(asset.url.lastIndexOf('/') + 1);
}

export default function SubtitlesSection({ movieId }: { movieId: string }) {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const canManage = isAdmin();

  const queryKey = ['admin', 'movies', movieId, 'subtitles'] as const;

  const [language, setLanguage] = useState<SubtitleLanguage>('en');
  const [mode, setMode] = useState<SourceMode>('library');
  const [asset, setAsset] = useState<AssetDto | null>(null);
  const [externalUrl, setExternalUrl] = useState('');
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SubtitleTrackDto | null>(null);

  const subtitlesQuery = useQuery({ queryKey, queryFn: () => listSubtitles(movieId) });
  const subtitles = subtitlesQuery.data ?? [];

  const usedLanguages = new Set(subtitles.map((track) => track.language));

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey });
  }

  function reportError(cause: unknown) {
    setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Try again.');
  }

  const addMutation = useMutation({
    mutationFn: () =>
      addSubtitle(movieId, {
        language,
        // Exactly one of these is sent — the server rejects both or neither.
        ...(mode === 'library'
          ? { asset_id: asset?.id }
          : { external_url: externalUrl.trim() }),
      }),
    onSuccess: () => {
      setAsset(null);
      setExternalUrl('');
      setError(null);
      invalidate();
    },
    onError: reportError,
  });

  const deleteMutation = useMutation({
    mutationFn: (subtitleId: string) => deleteSubtitle(movieId, subtitleId),
    onSuccess: () => {
      setPendingDelete(null);
      invalidate();
    },
    onError: (cause) => {
      setPendingDelete(null);
      reportError(cause);
    },
  });

  const canSubmit =
    !usedLanguages.has(language) &&
    (mode === 'library' ? asset !== null : externalUrl.trim() !== '');

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
              <th className="px-4 py-2.5 font-medium">Language</th>
              <th className="px-4 py-2.5 font-medium">Source</th>
              {canManage && <th className="px-4 py-2.5 text-right font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {subtitlesQuery.isPending && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}

            {subtitlesQuery.isSuccess && subtitles.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-slate-400">
                  No subtitle tracks yet.
                </td>
              </tr>
            )}

            {subtitles.map((track) => (
              <tr key={track.id} className="text-slate-300">
                <td className="px-4 py-3 text-slate-100">{LANGUAGE_LABELS[track.language]}</td>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-1.5 text-slate-400">
                    {track.asset ? (
                      <>
                        <FileText size={13} aria-hidden />
                        {fileNameOf(track.asset)}
                      </>
                    ) : (
                      <>
                        <Link2 size={13} aria-hidden />
                        <span className="truncate">{track.externalUrl}</span>
                      </>
                    )}
                  </span>
                </td>
                {canManage && (
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <button
                        type="button"
                        aria-label={`Delete ${LANGUAGE_LABELS[track.language]} subtitle`}
                        onClick={() => setPendingDelete(track)}
                        className="rounded-md border border-slate-700 p-1.5 text-rose-300 transition hover:bg-slate-800"
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <form
          className="mt-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            addMutation.mutate();
          }}
        >
          <h3 className="mb-3 text-sm font-medium text-slate-200">Add a subtitle track</h3>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label
                htmlFor="subtitle-language"
                className="mb-1 block text-xs font-medium text-slate-400"
              >
                Language
              </label>
              <select
                id="subtitle-language"
                value={language}
                onChange={(event) => setLanguage(event.target.value as SubtitleLanguage)}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
              >
                {SUBTITLE_LANGUAGES.map((value) => (
                  <option key={value} value={value} disabled={usedLanguages.has(value)}>
                    {LANGUAGE_LABELS[value]}
                    {usedLanguages.has(value) ? ' (already added)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <span className="mb-1 block text-xs font-medium text-slate-400">Source</span>
              <div className="flex rounded-md border border-slate-700">
                {(['library', 'external'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMode(value)}
                    className={`px-3 py-2 text-sm transition first:rounded-l-md last:rounded-r-md ${
                      mode === value
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {value === 'library' ? 'From library' : 'External URL'}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-w-64 flex-1">
              {mode === 'library' ? (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="w-full truncate rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-left text-sm text-slate-300 transition hover:border-slate-500"
                >
                  {asset ? fileNameOf(asset) : 'Choose a subtitle file…'}
                </button>
              ) : (
                <input
                  type="url"
                  value={externalUrl}
                  onChange={(event) => setExternalUrl(event.target.value)}
                  placeholder="https://example.com/subs/ar.vtt"
                  aria-label="External subtitle URL"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
                />
              )}
            </div>

            <button
              type="submit"
              disabled={!canSubmit || addMutation.isPending}
              className="flex items-center gap-1.5 rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-40"
            >
              <Plus size={14} aria-hidden />
              {addMutation.isPending ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      )}

      <AssetPickerModal
        open={isPickerOpen}
        kind="SUBTITLE"
        onSelect={setAsset}
        onClose={() => setPickerOpen(false)}
      />

      <Modal
        open={pendingDelete !== null}
        title="Delete subtitle track"
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
          Remove the{' '}
          <span className="font-medium text-slate-100">
            {pendingDelete && LANGUAGE_LABELS[pendingDelete.language]}
          </span>{' '}
          subtitle track? The file itself stays in the media library.
        </p>
      </Modal>
    </div>
  );
}

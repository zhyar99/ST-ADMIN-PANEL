import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Loader2, Trash2, Upload } from 'lucide-react';
import type { ImportJobDto } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { deleteImportJob, listImportJobs, uploadPlaylist } from '../../lib/importApi';
import Modal from '../../components/Modal';
import { JobStatusBadge } from './ImportBadges';

/**
 * Import landing page: upload a playlist, and see what previous uploads did.
 *
 * The upload is the only thing on this screen that touches the server hard —
 * parsing a 20 000-channel file happens inside the request — so the form is
 * explicit that it is working and refuses a second submission while it runs.
 */

const PAGE_SIZE = 25;

const FIELD_CLASS =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-slate-500';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function ImportPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const canManage = isAdmin();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ImportJobDto | null>(null);
  // Cursors already consumed, so "Previous" is a pop rather than a refetch.
  const [cursorStack, setCursorStack] = useState<string[]>([]);

  const cursor = cursorStack.at(-1);

  const jobsQuery = useQuery({
    queryKey: ['admin', 'import', 'jobs', cursor ?? 'FIRST'],
    queryFn: () => listImportJobs({ cursor, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const upload = useMutation({
    mutationFn: (playlist: File) => uploadPlaylist(playlist),
    onSuccess: (job) => {
      setFile(null);
      setUploadError(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      void queryClient.invalidateQueries({ queryKey: ['admin', 'import', 'jobs'] });
      // Straight to the review queue: an upload that nobody reviews has done
      // nothing, so the useful next screen is the entry list.
      navigate(`/import/${job.id}`);
    },
    onError: (cause) => {
      setUploadError(
        cause instanceof ApiError ? cause.message : 'Could not import that playlist.',
      );
    },
  });

  const removeJob = useMutation({
    mutationFn: (jobId: string) => deleteImportJob(jobId),
    onSuccess: () => {
      setPendingDelete(null);
      setListError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'import', 'jobs'] });
    },
    onError: (cause) => {
      setPendingDelete(null);
      setListError(cause instanceof ApiError ? cause.message : 'Could not delete that job.');
    },
  });

  const jobs = jobsQuery.data?.items ?? [];

  return (
    <div className="p-6">
      <header className="mb-5">
        <h1 className="text-lg font-semibold text-slate-100">Playlist import</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          Upload an M3U or M3U8 playlist to stage its channels for review. Nothing reaches the
          catalogue until you approve it, and approved entries arrive as drafts.
        </p>
      </header>

      {canManage && (
        <form
          className="mb-6 max-w-2xl rounded-lg border border-slate-800 bg-slate-900/40 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!file) {
              setUploadError('Choose a .m3u or .m3u8 file first.');
              return;
            }
            setUploadError(null);
            upload.mutate(file);
          }}
        >
          <label htmlFor="playlist-file" className="mb-1.5 block text-sm font-medium text-slate-200">
            Playlist file
          </label>
          <div className="flex items-end gap-3">
            <input
              ref={fileInputRef}
              id="playlist-file"
              type="file"
              accept=".m3u,.m3u8"
              disabled={upload.isPending}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setUploadError(null);
              }}
              className={`${FIELD_CLASS} file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-slate-200`}
            />
            <button
              type="submit"
              disabled={upload.isPending || !file}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {upload.isPending ? (
                <Loader2 size={14} aria-hidden className="animate-spin" />
              ) : (
                <Upload size={14} aria-hidden />
              )}
              {upload.isPending ? 'Importing…' : 'Import'}
            </button>
          </div>

          {upload.isPending && (
            <p className="mt-2 text-xs text-slate-400" role="status">
              Parsing the playlist. A large file can take a moment — this page stays open until it
              finishes.
            </p>
          )}

          {uploadError && (
            <p className="mt-2 text-sm text-rose-300" role="alert">
              {uploadError}
            </p>
          )}
        </form>
      )}

      {listError && (
        <p className="mb-4 text-sm text-rose-300" role="alert">
          {listError}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">File</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Entries</th>
              <th className="px-4 py-2.5 font-medium">Approved</th>
              <th className="px-4 py-2.5 font-medium">Rejected</th>
              <th className="px-4 py-2.5 font-medium">Imported</th>
              <th className="px-4 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {jobsQuery.isPending && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-400">
                  Loading imports…
                </td>
              </tr>
            )}

            {!jobsQuery.isPending && jobs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-slate-400">
                  <FileUp size={20} aria-hidden className="mx-auto mb-2 text-slate-600" />
                  No playlists imported yet.
                </td>
              </tr>
            )}

            {jobs.map((job) => (
              <tr key={job.id} className="hover:bg-slate-900/40">
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => navigate(`/import/${job.id}`)}
                    className="font-medium text-slate-100 underline-offset-2 hover:underline"
                  >
                    {job.filename}
                  </button>
                  {job.errorMessage && (
                    <p className="mt-0.5 text-xs text-rose-300">{job.errorMessage}</p>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <JobStatusBadge status={job.status} />
                </td>
                <td className="px-4 py-2.5 text-slate-300">{job.totalEntries}</td>
                <td className="px-4 py-2.5 text-slate-300">{job.approvedCount}</td>
                <td className="px-4 py-2.5 text-slate-300">{job.rejectedCount}</td>
                <td className="px-4 py-2.5 text-slate-400">{formatDate(job.createdAt)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/import/${job.id}`)}
                      className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-slate-800"
                    >
                      View entries
                    </button>
                    {/* A job still processing has entries mid-insert; deleting
                        it is only offered once it has settled. */}
                    {canManage && (job.status === 'DONE' || job.status === 'FAILED') && (
                      <button
                        type="button"
                        aria-label={`Delete import ${job.filename}`}
                        onClick={() => setPendingDelete(job)}
                        className="rounded-md border border-slate-700 p-1.5 text-rose-300 transition hover:bg-slate-800"
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={cursorStack.length === 0}
          onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!jobsQuery.data?.nextCursor}
          onClick={() => {
            const next = jobsQuery.data?.nextCursor;
            if (next) setCursorStack((stack) => [...stack, next]);
          }}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>

      <Modal
        open={pendingDelete !== null}
        title="Delete this import?"
        description="The job and its staged entries are removed. Channels and movies you already approved are not affected."
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
              disabled={removeJob.isPending}
              onClick={() => pendingDelete && removeJob.mutate(pendingDelete.id)}
              className="rounded-md bg-rose-500/90 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-rose-500 disabled:opacity-50"
            >
              Delete
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          {pendingDelete?.filename} — {pendingDelete?.totalEntries} staged{' '}
          {pendingDelete?.totalEntries === 1 ? 'entry' : 'entries'}.
        </p>
      </Modal>
    </div>
  );
}

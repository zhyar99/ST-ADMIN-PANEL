import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import type { GenreListItemDto, LocalizedText, SupportedLocale } from '@streaming/shared';
import { SUPPORTED_LOCALES } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import { createGenre, deleteGenre, listGenres, updateGenre } from '../../lib/catalogApi';
import { LOCALE_DIRECTION, LOCALE_LABELS } from '../../components/LocalizedTabs';
import Modal from '../../components/Modal';

const EMPTY_NAME: LocalizedText = { en: '', ckb: '', ar: '' };

const GENRES_KEY = ['admin', 'genres'] as const;

function isComplete(name: LocalizedText): boolean {
  return SUPPORTED_LOCALES.every((locale) => name[locale].trim() !== '');
}

/** One row of three language inputs, shared by the create and edit forms. */
function NameFields({
  value,
  onChange,
  idPrefix,
}: {
  value: LocalizedText;
  onChange: (next: LocalizedText) => void;
  idPrefix: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {SUPPORTED_LOCALES.map((locale) => (
        <div key={locale}>
          <label
            htmlFor={`${idPrefix}-${locale}`}
            className="mb-1 block text-xs font-medium text-slate-400"
          >
            {LOCALE_LABELS[locale]}
          </label>
          <input
            id={`${idPrefix}-${locale}`}
            type="text"
            dir={LOCALE_DIRECTION[locale]}
            value={value[locale]}
            onChange={(event) => onChange({ ...value, [locale]: event.target.value })}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
          />
        </div>
      ))}
    </div>
  );
}

export default function GenresPage() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = isAdmin();

  const [draft, setDraft] = useState<LocalizedText>(EMPTY_NAME);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<LocalizedText>(EMPTY_NAME);
  const [pendingDelete, setPendingDelete] = useState<GenreListItemDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const genresQuery = useQuery({ queryKey: GENRES_KEY, queryFn: listGenres });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: GENRES_KEY });
  }

  function reportError(cause: unknown) {
    setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Try again.');
  }

  const createMutation = useMutation({
    mutationFn: () => createGenre({ name_i18n: draft }),
    onSuccess: () => {
      setDraft(EMPTY_NAME);
      setError(null);
      invalidate();
    },
    onError: reportError,
  });

  const updateMutation = useMutation({
    mutationFn: (id: string) => updateGenre(id, { name_i18n: editDraft }),
    onSuccess: () => {
      setEditingId(null);
      setError(null);
      invalidate();
    },
    onError: reportError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteGenre(id),
    onSuccess: () => {
      setPendingDelete(null);
      setError(null);
      invalidate();
    },
    onError: (cause) => {
      setPendingDelete(null);
      reportError(cause);
    },
  });

  const genres = genresQuery.data ?? [];

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-slate-100">Genres</h1>
        <p className="mt-1 text-sm text-slate-400">
          The genre vocabulary used across the catalogue. Every genre needs all three languages.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}

      {canEdit && (
        <form
          className="mb-6 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            createMutation.mutate();
          }}
        >
          <h2 className="mb-3 text-sm font-medium text-slate-200">Add a genre</h2>
          <NameFields value={draft} onChange={setDraft} idPrefix="new-genre" />
          <div className="mt-3 flex justify-end">
            <button
              type="submit"
              disabled={!isComplete(draft) || createMutation.isPending}
              className="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-40"
            >
              {createMutation.isPending ? 'Adding…' : 'Add genre'}
            </button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              {SUPPORTED_LOCALES.map((locale) => (
                <th key={locale} className="px-4 py-2.5 font-medium">
                  {LOCALE_LABELS[locale]}
                </th>
              ))}
              <th className="px-4 py-2.5 font-medium">Movies</th>
              {canEdit && <th className="px-4 py-2.5 text-right font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {genresQuery.isPending && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}

            {genresQuery.isSuccess && genres.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  No genres yet.
                </td>
              </tr>
            )}

            {genres.map((item) =>
              editingId === item.id ? (
                <tr key={item.id} className="bg-slate-900/40">
                  <td colSpan={canEdit ? 5 : 4} className="px-4 py-3">
                    <NameFields
                      value={editDraft}
                      onChange={setEditDraft}
                      idPrefix={`edit-${item.id}`}
                    />
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800"
                      >
                        <X size={13} aria-hidden />
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!isComplete(editDraft) || updateMutation.isPending}
                        onClick={() => updateMutation.mutate(item.id)}
                        className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-900 transition hover:bg-white disabled:opacity-40"
                      >
                        <Check size={13} aria-hidden />
                        Save
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={item.id} className="text-slate-200">
                  {SUPPORTED_LOCALES.map((locale: SupportedLocale) => (
                    <td key={locale} className="px-4 py-3" dir={LOCALE_DIRECTION[locale]}>
                      {item.nameI18n[locale]}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-slate-400">{item.movieCount}</td>
                  {canEdit && (
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          aria-label={`Edit ${item.nameI18n.en}`}
                          onClick={() => {
                            setEditingId(item.id);
                            setEditDraft(item.nameI18n);
                          }}
                          className="rounded-md border border-slate-700 p-1.5 text-slate-300 transition hover:bg-slate-800"
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${item.nameI18n.en}`}
                          disabled={item.movieCount > 0}
                          title={
                            item.movieCount > 0
                              ? `Assigned to ${item.movieCount} movie${item.movieCount === 1 ? '' : 's'} — remove it from them first`
                              : undefined
                          }
                          onClick={() => setPendingDelete(item)}
                          className="rounded-md border border-slate-700 p-1.5 text-rose-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={pendingDelete !== null}
        title="Delete genre"
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
          This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

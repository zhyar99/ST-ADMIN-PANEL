import { useEffect, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, LayoutList, Pencil, Plus, Trash2 } from 'lucide-react';
import type { HomeRowDto, LocalizedText, SupportedLocale } from '@streaming/shared';
import { SUPPORTED_LOCALES } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/authContext';
import {
  createHomeRow,
  deleteHomeRow,
  listHomeRows,
  reorderHomeRows,
  updateHomeRow,
} from '../../lib/homeApi';
import LocalizedTabs, { LOCALE_DIRECTION } from '../../components/LocalizedTabs';
import Modal from '../../components/Modal';
import HomeRowItemsPage from './HomeRowItemsPage';
import { HOME_ROWS_KEY } from './homeKeys';

/**
 * Home row ordering.
 *
 * The row order is what the consumer Home page renders top to bottom, so the
 * drag here is the feature rather than a convenience. A drop reorders
 * optimistically and PUTs the full id list; the server rejects a partial one,
 * which is why this page always sends every row it knows about.
 */

const EMPTY_TITLE: LocalizedText = { en: '', ckb: '', ar: '' };

function isComplete(title: LocalizedText): boolean {
  return SUPPORTED_LOCALES.every((locale) => title[locale].trim() !== '');
}

function SortableRow({
  row,
  canEdit,
  busy,
  onEdit,
  onItems,
  onDelete,
}: {
  row: HomeRowDto;
  canEdit: boolean;
  busy: boolean;
  onEdit: () => void;
  onItems: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
    disabled: !canEdit || busy,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 ${
        isDragging ? 'z-10 opacity-80 ring-1 ring-slate-600' : ''
      }`}
    >
      {canEdit && (
        <button
          type="button"
          aria-label={`Reorder ${row.titleI18n.en}`}
          disabled={busy}
          className="cursor-grab text-slate-500 hover:text-slate-300 disabled:cursor-not-allowed"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={16} aria-hidden />
        </button>
      )}

      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-100">{row.titleI18n.en}</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {row.itemRefs.length} {row.itemRefs.length === 1 ? 'item' : 'items'}
        </p>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onItems}
          className="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800"
        >
          <LayoutList size={13} aria-hidden />
          Items
        </button>

        {canEdit && (
          <>
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit ${row.titleI18n.en}`}
              className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            >
              <Pencil size={14} aria-hidden />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete ${row.titleI18n.en}`}
              className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-rose-300"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export default function HomeOrderPage() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = isAdmin();

  const rowsQuery = useQuery({ queryKey: HOME_ROWS_KEY, queryFn: listHomeRows });

  /**
   * Local copy of the order, so a drag renders immediately instead of waiting
   * on the round trip. Re-synced whenever the server's list changes.
   */
  const [rows, setRows] = useState<HomeRowDto[]>([]);
  useEffect(() => {
    if (rowsQuery.data) setRows(rowsQuery.data);
  }, [rowsQuery.data]);

  const [editing, setEditing] = useState<HomeRowDto | 'new' | null>(null);
  const [draft, setDraft] = useState<LocalizedText>(EMPTY_TITLE);
  const [itemsFor, setItemsFor] = useState<HomeRowDto | null>(null);
  const [pendingDelete, setPendingDelete] = useState<HomeRowDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: HOME_ROWS_KEY });
  }

  function reportError(cause: unknown) {
    setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Try again.');
  }

  const reorderMutation = useMutation({
    mutationFn: reorderHomeRows,
    onSuccess: (updated) => {
      setError(null);
      queryClient.setQueryData(HOME_ROWS_KEY, updated);
    },
    onError: (cause) => {
      // The optimistic order is now a lie; drop back to whatever the server has.
      reportError(cause);
      invalidate();
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      editing === 'new'
        ? createHomeRow({ title_i18n: draft })
        : updateHomeRow(editing!.id, { title_i18n: draft }),
    onSuccess: () => {
      setEditing(null);
      setError(null);
      invalidate();
    },
    onError: reportError,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteHomeRow(id),
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

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = rows.findIndex((row) => row.id === active.id);
    const to = rows.findIndex((row) => row.id === over.id);
    if (from === -1 || to === -1) return;

    const next = arrayMove(rows, from, to);
    setRows(next);
    reorderMutation.mutate(next.map((row) => row.id));
  }

  function openCreate() {
    setDraft(EMPTY_TITLE);
    setEditing('new');
  }

  function openEdit(row: HomeRowDto) {
    setDraft(row.titleI18n);
    setEditing(row);
  }

  // The item editor holds the row it was opened with, so it has to follow the
  // refetched copy after a save — otherwise "Save items" would leave the panel
  // showing the pre-save refs and report unsaved changes forever.
  const openItemsRow = itemsFor && (rows.find((row) => row.id === itemsFor.id) ?? itemsFor);

  return (
    <div className="p-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Home Rows</h1>
          <p className="mt-1 text-sm text-slate-400">
            The curated rows on the consumer home screen, top to bottom. Rows whose items are all
            unpublished are skipped automatically.
          </p>
        </div>

        {canEdit && (
          <button
            type="button"
            onClick={openCreate}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-slate-200 px-3 py-2 text-sm font-medium text-slate-900 transition hover:bg-white"
          >
            <Plus size={15} aria-hidden />
            Add Row
          </button>
        )}
      </header>

      {error && (
        <p className="mb-4 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}

      {rowsQuery.isPending && <p className="text-sm text-slate-500">Loading…</p>}

      {rowsQuery.isError && (
        <p className="text-sm text-rose-300">Could not load home rows.</p>
      )}

      {rowsQuery.isSuccess && rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-500">
          No home rows yet. Add one to start curating the home screen.
        </p>
      )}

      {rows.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
            <ul className="space-y-2">
              {rows.map((row) => (
                <SortableRow
                  key={row.id}
                  row={row}
                  canEdit={canEdit}
                  busy={reorderMutation.isPending}
                  onEdit={() => openEdit(row)}
                  onItems={() => setItemsFor(row)}
                  onDelete={() => setPendingDelete(row)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'Add home row' : 'Edit home row'}
        description="The row heading, in all three languages."
        onClose={() => setEditing(null)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!isComplete(draft) || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
              className="rounded-md bg-slate-200 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-50"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <LocalizedTabs
          invalidLocales={SUPPORTED_LOCALES.filter((locale) => draft[locale].trim() === '')}
        >
          {(locale: SupportedLocale) => (
            <div>
              <label
                htmlFor={`home-row-title-${locale}`}
                className="mb-1 block text-xs font-medium text-slate-400"
              >
                Row title
              </label>
              <input
                id={`home-row-title-${locale}`}
                type="text"
                dir={LOCALE_DIRECTION[locale]}
                value={draft[locale]}
                onChange={(event) => setDraft({ ...draft, [locale]: event.target.value })}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
              />
            </div>
          )}
        </LocalizedTabs>
      </Modal>

      <Modal
        open={openItemsRow !== null}
        size="lg"
        title={openItemsRow ? `Items — ${openItemsRow.titleI18n.en}` : 'Items'}
        description="Drag to reorder. Home renders these left to right."
        onClose={() => setItemsFor(null)}
      >
        {openItemsRow && <HomeRowItemsPage row={openItemsRow} />}
      </Modal>

      <Modal
        open={pendingDelete !== null}
        title="Delete home row"
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
              onClick={() => deleteMutation.mutate(pendingDelete!.id)}
              className="rounded-md bg-rose-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-rose-400 disabled:opacity-50"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete row'}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          Delete <span className="font-medium text-slate-100">{pendingDelete?.titleI18n.en}</span>?
          The movies, series and channels it lists are not affected — only the row itself is
          removed.
        </p>
      </Modal>
    </div>
  );
}

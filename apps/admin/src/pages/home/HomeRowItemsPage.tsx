import { useEffect, useMemo, useState } from 'react';
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
import { AlertTriangle, GripVertical, Plus, Search, Trash2 } from 'lucide-react';
import type { ContentSearchResult, HomeItemRef, HomeItemRefType, HomeRowDto } from '@streaming/shared';

import { ApiError } from '../../lib/api';
import { lookupContent, searchContent, setHomeRowItems } from '../../lib/homeApi';
import { HOME_ROWS_KEY } from './homeKeys';

/**
 * The item editor for one Home row.
 *
 * Edits are staged locally and committed by "Save": a drag is a cheap,
 * frequently-undone gesture, and PATCHing the whole row on every intermediate
 * drop would write a row nobody asked for each time an operator changed their
 * mind halfway through reordering ten items.
 */

const TYPE_LABEL: Record<HomeItemRefType, string> = {
  MOVIE: 'MOVIE',
  SERIES: 'SERIES',
  LIVE_CHANNEL: 'LIVE',
};

const TYPE_BADGE: Record<HomeItemRefType, string> = {
  MOVIE: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  SERIES: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  LIVE_CHANNEL: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
};

const refKey = (ref: HomeItemRef) => `${ref.type}:${ref.id}`;

function TypeBadge({ type }: { type: HomeItemRefType }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ring-1 ring-inset ${TYPE_BADGE[type]}`}
    >
      {TYPE_LABEL[type]}
    </span>
  );
}

function SortableItem({
  refItem,
  title,
  onRemove,
  disabled,
}: {
  refItem: HomeItemRef;
  title: string | undefined;
  onRemove: () => void;
  disabled: boolean;
}) {
  const key = refKey(refItem);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: key,
    disabled,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 ${
        isDragging ? 'z-10 opacity-80 ring-1 ring-slate-600' : ''
      }`}
    >
      <button
        type="button"
        aria-label={`Reorder ${title ?? key}`}
        disabled={disabled}
        className="cursor-grab text-slate-500 hover:text-slate-300 disabled:cursor-not-allowed"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} aria-hidden />
      </button>

      <TypeBadge type={refItem.type} />

      {title === undefined ? (
        // Kept visible rather than dropped: this entry is still in the row and
        // still removable, and it is precisely the one an operator needs to
        // know about, since Home will silently skip it.
        <span className="flex items-center gap-1.5 text-sm text-amber-300">
          <AlertTriangle size={13} aria-hidden />
          Unavailable — unpublished or deleted
        </span>
      ) : (
        <span className="truncate text-sm text-slate-200">{title}</span>
      )}

      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${title ?? key}`}
        className="ml-auto rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-rose-300 disabled:opacity-50"
      >
        <Trash2 size={14} aria-hidden />
      </button>
    </li>
  );
}

export default function HomeRowItemsPage({ row }: { row: HomeRowDto }) {
  const queryClient = useQueryClient();

  const [items, setItems] = useState<HomeItemRef[]>(row.itemRefs);
  const [term, setTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<HomeItemRefType | ''>('');
  const [error, setError] = useState<string | null>(null);

  // A different row in the same modal shell must not inherit the previous
  // row's staged edits.
  useEffect(() => {
    setItems(row.itemRefs);
    setError(null);
  }, [row.id, row.itemRefs]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Titles for the refs currently staged, so drags do not re-fetch. */
  const lookupQuery = useQuery({
    queryKey: ['admin', 'home', 'lookup', [...items].map(refKey).sort()],
    queryFn: () => lookupContent(items),
    enabled: items.length > 0,
  });

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const result of lookupQuery.data ?? []) map.set(refKey(result), result.title);
    return map;
  }, [lookupQuery.data]);

  const searchResults = useQuery({
    queryKey: ['admin', 'home', 'search', term, typeFilter],
    queryFn: () => searchContent({ q: term || undefined, type: typeFilter || undefined }),
  });

  const saveMutation = useMutation({
    mutationFn: () => setHomeRowItems(row.id, items),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: HOME_ROWS_KEY });
    },
    onError: (cause: unknown) =>
      setError(cause instanceof ApiError ? cause.message : 'Could not save. Try again.'),
  });

  const staged = new Set(items.map(refKey));
  const dirty =
    items.length !== row.itemRefs.length ||
    items.some((item, index) => refKey(item) !== refKey(row.itemRefs[index]!));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = items.findIndex((item) => refKey(item) === active.id);
    const to = items.findIndex((item) => refKey(item) === over.id);
    if (from === -1 || to === -1) return;

    setItems(arrayMove(items, from, to));
  }

  function addItem(result: ContentSearchResult) {
    if (staged.has(refKey(result))) return;
    setItems([...items, { type: result.type, id: result.id }]);
  }

  return (
    <div className="space-y-5">
      {error && (
        <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </p>
      )}

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          In this row ({items.length})
        </h3>

        {items.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-800 px-3 py-6 text-center text-sm text-slate-500">
            No items yet. Add some below — a row with nothing in it is skipped on Home.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={items.map(refKey)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-2">
                {items.map((item) => (
                  <SortableItem
                    key={refKey(item)}
                    refItem={item}
                    title={titles.get(refKey(item))}
                    disabled={saveMutation.isPending}
                    onRemove={() =>
                      setItems(items.filter((entry) => refKey(entry) !== refKey(item)))
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          Add an item
        </h3>

        <div className="mb-3 flex gap-2">
          <div className="relative flex-1">
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search published content…"
              aria-label="Search published content"
              className="w-full rounded-md border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none focus:border-slate-500"
            />
          </div>

          <select
            value={typeFilter}
            aria-label="Filter by type"
            onChange={(event) => setTypeFilter(event.target.value as HomeItemRefType | '')}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-200 outline-none focus:border-slate-500"
          >
            <option value="">All types</option>
            <option value="MOVIE">Movies</option>
            <option value="SERIES">Series</option>
            <option value="LIVE_CHANNEL">Live TV</option>
          </select>
        </div>

        <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-slate-800 p-1">
          {searchResults.isPending && (
            <li className="px-2 py-3 text-sm text-slate-500">Searching…</li>
          )}

          {searchResults.data?.length === 0 && (
            <li className="px-2 py-3 text-sm text-slate-500">
              No published content matches that.
            </li>
          )}

          {searchResults.data?.map((result) => {
            const already = staged.has(refKey(result));

            return (
              <li key={refKey(result)}>
                <button
                  type="button"
                  disabled={already}
                  onClick={() => addItem(result)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500 disabled:hover:bg-transparent"
                >
                  <TypeBadge type={result.type} />
                  <span className="truncate">{result.title}</span>
                  <span className="ml-auto shrink-0 text-slate-500">
                    {already ? 'Added' : <Plus size={14} aria-hidden />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="flex items-center justify-end gap-2 border-t border-slate-800 pt-4">
        {dirty && <span className="mr-auto text-xs text-amber-300">Unsaved changes</span>}

        <button
          type="button"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => setItems(row.itemRefs)}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
        >
          Revert
        </button>
        <button
          type="button"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          className="rounded-md bg-slate-200 px-3 py-1.5 text-sm font-medium text-slate-900 transition hover:bg-white disabled:opacity-50"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save items'}
        </button>
      </div>
    </div>
  );
}

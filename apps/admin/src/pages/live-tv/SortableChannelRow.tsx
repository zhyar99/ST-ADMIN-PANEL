import { flexRender, type Row } from '@tanstack/react-table';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDownToLine, ArrowUpToLine, GripVertical } from 'lucide-react';
import type { LiveChannelListItemDto } from '@streaming/shared';

export default function SortableChannelRow({ row, disabled, onOpen, onMove }: {
  row: Row<LiveChannelListItemDto>;
  disabled: boolean;
  onOpen: () => void;
  onMove: (placement: 'first' | 'last') => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.original.id, disabled,
  });
  const name = row.original.nameI18n.en;
  return (
    <tr ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={onOpen}
      className={`cursor-pointer text-slate-300 hover:bg-slate-900/60 ${isDragging ? 'relative z-10 bg-slate-900 opacity-80' : ''}`}>
      {row.getVisibleCells().map((cell) => (
        <td key={cell.id} className="px-4 py-3"
          onClick={['actions', 'select', 'order'].includes(cell.column.id) ? (event) => event.stopPropagation() : undefined}>
          {cell.column.id === 'order' ? (
            <div className="flex items-center gap-1">
              <button type="button" {...attributes} {...listeners} disabled={disabled}
                aria-label={`Drag to reorder ${name}`} title="Drag to reorder; use Space and arrow keys with a keyboard"
                className="touch-none cursor-grab rounded p-1 hover:bg-slate-800 disabled:opacity-40">
                <GripVertical size={16} aria-hidden />
              </button>
              <button type="button" disabled={disabled} onClick={() => onMove('first')}
                aria-label={`Move ${name} to top of all channels`} title="Move to top of all channels"
                className="rounded p-1 hover:bg-slate-800 disabled:opacity-40"><ArrowUpToLine size={13} aria-hidden /></button>
              <button type="button" disabled={disabled} onClick={() => onMove('last')}
                aria-label={`Move ${name} to bottom of all channels`} title="Move to bottom of all channels"
                className="rounded p-1 hover:bg-slate-800 disabled:opacity-40"><ArrowDownToLine size={13} aria-hidden /></button>
            </div>
          ) : flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );
}

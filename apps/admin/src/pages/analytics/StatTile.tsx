interface StatTileProps {
  label: string;
  value: string | number;
  hint?: string;
}

/** One number and its label. The tile row's only building block. */
export default function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-100">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

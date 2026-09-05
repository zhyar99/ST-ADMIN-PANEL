interface PlaceholderPageProps {
  title: string;
  description?: string;
}

/** Temporary page body used until each section is built in a later phase. */
export default function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-slate-100">{title}</h1>
      <p className="mt-2 text-sm text-slate-400">{description ?? 'Not implemented yet.'}</p>
    </div>
  );
}

// Placeholder panel for a dashboard area that has no data source yet.
export default function EmptyPanel({ title, children }) {
  return (
    <section className="rounded-sm border border-dashed border-line-strong p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-6 text-ink-soft">
        {children}
      </p>
    </section>
  );
}

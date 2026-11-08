// Static status list. Nothing is connected yet, so every row says so.
// Replace the hard-coded states with real health checks once each part exists.
const parts = [
  {
    name: "MySQL",
    detail: "Cases, evidence, custody history and audit records",
    status: "Not connected",
  },
  {
    name: "Qdrant",
    detail: "Semantic search index",
    status: "Not connected",
  },
  {
    name: "Sign-in and roles",
    detail: "Administrator and Investigator access",
    status: "Not built",
  },
  {
    name: "Embedding worker",
    detail: "Converts evidence text into search vectors",
    status: "Not built",
  },
];

export default function ConnectionStatus() {
  return (
    <section className="rounded-sm border border-line bg-panel">
      <h2 className="border-b border-line px-5 py-4 text-base font-semibold">
        System connections
      </h2>
      <ul className="divide-y divide-line">
        {parts.map((part) => (
          <li
            key={part.name}
            className="flex items-start justify-between gap-4 px-5 py-4"
          >
            <div>
              <p className="text-sm font-medium">{part.name}</p>
              <p className="mt-0.5 text-sm text-ink-soft">{part.detail}</p>
            </div>
            <p className="flex shrink-0 items-center gap-2 text-sm text-ink-soft">
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full border-2 border-ink-soft"
              />
              {part.status}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

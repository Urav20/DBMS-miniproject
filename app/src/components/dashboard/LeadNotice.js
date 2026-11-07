// The project's core rule, shown wherever search results will appear.
export default function LeadNotice() {
  return (
    <aside className="border-l-4 border-marker bg-marker-wash p-5">
      <h2 className="text-base font-semibold text-marker-ink">
        A match is a lead, not proof
      </h2>
      <p className="mt-2 text-sm leading-6">
        Semantic search ranks evidence by similarity of meaning. Similar wording
        does not show that two items are related. Only an analyst can record a
        relationship, and must give a written reason.
      </p>
    </aside>
  );
}

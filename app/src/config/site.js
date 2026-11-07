// Single place for the product name and navigation.
// Pages listed under `planned` are not built yet; they are shown as plain text, not links.

export const site = {
  name: "TRACE-X",
  tagline: "Digital evidence provenance",
  description:
    "TRACE-X keeps the full history of digital evidence in MySQL and uses semantic search to suggest leads. Only an analyst can record that two items are related.",
};

export const navigation = {
  primary: [{ label: "Dashboard", href: "/dashboard" }],
  planned: ["Cases", "Evidence", "Search", "Reports", "Administration"],
};

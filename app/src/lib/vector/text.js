// What text is embedded (design doc section 5.1): evidence = title + description +
// extracted_text; finding = title + description. Analysis notes are not embedded.

// bge-small-en-v1.5: queries get this instruction prefix, documents get none.
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

function join(parts) {
  return parts
    .map((p) => (p === null || p === undefined ? "" : String(p).trim()))
    .filter((p) => p.length > 0)
    .join("\n\n");
}

export function buildEvidenceText(row) {
  return join([row?.title, row?.description, row?.extracted_text]);
}

export function buildFindingText(row) {
  return join([row?.title, row?.description]);
}

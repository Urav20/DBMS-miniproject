// node evaluation/scripts/generate.mjs
// Rebuilds evaluation/data/{dataset,qrels,query-audit}.json. Deterministic: same seed, same files.
import { writeDatasetFiles } from "../src/dataset.mjs";
const { dataset, queries, audit } = writeDatasetFiles();
console.log(`dataset: ${dataset.meta.total} records, seed ${dataset.meta.seed}, sha256 ${dataset.meta.content_sha256.slice(0, 16)}...`);
console.log(`small tier: ${dataset.meta.records_in_small_tier} records; queries: ${queries.length}`);
const by = {};
for (const a of audit) (by[a.category] ??= []).push(a.coverage);
for (const [c, v] of Object.entries(by)) console.log(`  ${c.padEnd(16)} mean share of query words found in relevant records: ${(v.reduce((x, y) => x + y, 0) / v.length).toFixed(2)}`);

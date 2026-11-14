// Keyword retrieval: MySQL InnoDB FULLTEXT (ft_evidence_text on title, description, extracted_text),
// natural-language mode, exactly the approach of Person A's Q13. No stemming, synonyms or query
// rewriting is added. Runs as an administrator because MATCH cannot run through the
// investigator views (see README, "Limitations").

export function keywordSql(caseCount, depth) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 200) throw new RangeError("depth must be 1..200");
  if (!Number.isInteger(caseCount) || caseCount < 1) throw new RangeError("at least one case id is required");
  const marks = Array(caseCount).fill("?").join(", ");
  return (
    "SELECT e.evidence_id, MATCH(e.title, e.description, e.extracted_text) AGAINST (? IN NATURAL LANGUAGE MODE) AS score " +
    "FROM evidence e " +
    "WHERE MATCH(e.title, e.description, e.extracted_text) AGAINST (? IN NATURAL LANGUAGE MODE) " +
    `AND e.status = 'active' AND e.case_id IN (${marks}) ` +
    `ORDER BY score DESC, e.evidence_id ASC LIMIT ${depth}`
  );
}

export function createKeywordMethod({ db, session, caseIds, depth, name = "keyword" }) {
  const sql = keywordSql(caseIds.length, depth);
  return {
    name,
    async search(text) {
      const rows = await db.withSession(session, (q) => q.query(sql, [text, text, ...caseIds]));
      return { ids: rows.map((r) => Number(r.evidence_id)), scores: rows.map((r) => Number(r.score)) };
    },
  };
}

-- =====================================================================
-- TRACE-X  |  05_queries.sql
-- Query showcase (rubric item 7): joins, nested and correlated subqueries,
-- aggregation, window functions, RECURSIVE CTEs, full-text search.
--
-- Run after 01-03 and the seed (04_dml.sql is optional):
--     source database/05_queries.sql
-- These run as the administrator/root account (base tables). The app runs
-- the investigator versions through the v_my_* views; Q14 shows that.
-- Evidence ids: case 1 = 1..12, case 2 = 13..24, case 3 = 25..36,
-- case 4 = 37..48, case 5 = 49..60 (E<n> of a case = first id + n - 1).
-- =====================================================================
USE tracex;

-- Q1. Five-table join: every evidence item with case, type, source and
--     current custodian (case 5 only, to keep the output short).
SELECT e.evidence_no, c.case_number, t.name AS type, s.label AS source,
       cc.current_custodian_name AS held_by
FROM evidence e
JOIN investigation_case c ON c.case_id = e.case_id
JOIN evidence_type t      ON t.type_id = e.type_id
LEFT JOIN evidence_source s ON s.source_id = e.source_id
JOIN v_current_custody cc ON cc.evidence_id = e.evidence_id
WHERE c.case_number = 'TX-2026-005'
ORDER BY e.evidence_no;

-- Q2. Aggregation with HAVING: cases with at least 3 high or critical findings.
SELECT c.case_number, COUNT(*) AS serious_findings
FROM finding f
JOIN analysis a ON a.analysis_id = f.analysis_id
JOIN evidence e ON e.evidence_id = a.evidence_id
JOIN investigation_case c ON c.case_id = e.case_id
WHERE f.severity IN ('high', 'critical')
GROUP BY c.case_id, c.case_number
HAVING COUNT(*) >= 3
ORDER BY serious_findings DESC;

-- Q3. Nested subquery (IN): cases where custody was handed to someone whose
--     access to that case has since been revoked (worth a second look).
SELECT case_number, title
FROM investigation_case
WHERE case_id IN (
  SELECT e.case_id
  FROM custody_event ce
  JOIN evidence e ON e.evidence_id = ce.evidence_id
  JOIN case_assignment ca ON ca.case_id = e.case_id AND ca.user_id = ce.to_user_id
  WHERE ca.revoked_at IS NOT NULL);

-- Q4. Correlated subquery: evidence with more findings than the average
--     evidence item of its own case.
SELECT e.evidence_no, e.title,
       (SELECT COUNT(*) FROM finding f JOIN analysis a ON a.analysis_id = f.analysis_id
        WHERE a.evidence_id = e.evidence_id) AS findings
FROM evidence e
WHERE (SELECT COUNT(*) FROM finding f JOIN analysis a ON a.analysis_id = f.analysis_id
       WHERE a.evidence_id = e.evidence_id)
    > (SELECT AVG(per_item.n)
       FROM (SELECT e2.evidence_id, e2.case_id, COUNT(f2.finding_id) AS n
             FROM evidence e2
             LEFT JOIN analysis a2 ON a2.evidence_id = e2.evidence_id
             LEFT JOIN finding f2 ON f2.analysis_id = a2.analysis_id
             GROUP BY e2.evidence_id, e2.case_id) per_item
       WHERE per_item.case_id = e.case_id)
ORDER BY e.evidence_no;

-- Q5. Correlated NOT EXISTS: active evidence that has never been analysed.
SELECT e.evidence_no, e.title
FROM evidence e
WHERE e.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM analysis a WHERE a.evidence_id = e.evidence_id)
ORDER BY e.evidence_no;

-- Q6. Chain of custody as one line per item, for items passed on at least twice.
SELECT e.evidence_no,
       COUNT(*) AS events,
       GROUP_CONCAT(u.username ORDER BY ce.seq_no SEPARATOR ' > ') AS chain
FROM custody_event ce
JOIN evidence e ON e.evidence_id = ce.evidence_id
JOIN app_user u ON u.user_id = ce.to_user_id
GROUP BY e.evidence_id, e.evidence_no
HAVING COUNT(*) >= 3
ORDER BY events DESC, e.evidence_no;

-- Q7. Window function (LEAD): how long each person held each item before
--     passing it on; the five longest holds.
SELECT evidence_no, holder, held_from, held_until,
       TIMESTAMPDIFF(HOUR, held_from, held_until) AS hours_held
FROM (
  SELECT e.evidence_no, u.username AS holder, ce.transferred_at AS held_from,
         LEAD(ce.transferred_at) OVER (PARTITION BY ce.evidence_id ORDER BY ce.seq_no) AS held_until
  FROM custody_event ce
  JOIN evidence e ON e.evidence_id = ce.evidence_id
  JOIN app_user u ON u.user_id = ce.to_user_id
) holds
WHERE held_until IS NOT NULL
ORDER BY hours_held DESC
LIMIT 5;

-- Q8. Window function (ROW_NUMBER): the most severe finding of each case.
SELECT case_number, severity, finding_title
FROM (
  SELECT c.case_number, f.severity, f.title AS finding_title,
         ROW_NUMBER() OVER (PARTITION BY c.case_id ORDER BY f.severity DESC, f.created_at) AS rn
  FROM finding f
  JOIN analysis a ON a.analysis_id = f.analysis_id
  JOIN evidence e ON e.evidence_id = a.evidence_id
  JOIN investigation_case c ON c.case_id = e.case_id
) ranked
WHERE rn = 1
ORDER BY case_number;

-- Q9. Anti-join (LEFT JOIN ... IS NULL): evidence that has never been
--     passed on, i.e. whose custody chain is only the intake event.
SELECT e.evidence_no, e.title
FROM evidence e
LEFT JOIN custody_event moved ON moved.evidence_id = e.evidence_id AND moved.seq_no > 1
WHERE moved.evidence_id IS NULL
ORDER BY e.evidence_no
LIMIT 10;

-- Q10. RECURSIVE CTE, directed: follow the "earlier link -> later link"
--      direction from E7 of case 1 (id 7). depth = number of hops;
--      the route column is the cycle guard (an id never repeats in a route).
WITH RECURSIVE chain (evidence_id, depth, route) AS (
  SELECT 7, 0, CAST(',7,' AS CHAR(500))
  UNION ALL
  SELECT r.evidence_b_id, c.depth + 1,
         CAST(CONCAT(c.route, r.evidence_b_id, ',') AS CHAR(500))
  FROM chain c
  JOIN evidence_relationship r ON r.evidence_a_id = c.evidence_id
  WHERE LOCATE(CONCAT(',', r.evidence_b_id, ','), c.route) = 0
)
SELECT c.depth, e.evidence_no, e.title, c.route
FROM chain c JOIN evidence e ON e.evidence_id = c.evidence_id
ORDER BY c.depth, e.evidence_no;

-- Q11. RECURSIVE CTE, cycle detection: case 1 contains a deliberate loop
--      (E3 -> E10 -> E9 -> E3). Without the guard this would never stop.
--      Here the walk continues one step past a repeated id so that the
--      loop is reported instead of silently skipped.
WITH RECURSIVE walk (start_id, current_id, depth, route, closes_loop) AS (
  SELECT e.evidence_id, e.evidence_id, 0, CAST(CONCAT(',', e.evidence_id, ',') AS CHAR(500)), 0
  FROM evidence e WHERE e.case_id = 1
  UNION ALL
  SELECT w.start_id, r.evidence_b_id, w.depth + 1,
         CAST(CONCAT(w.route, r.evidence_b_id, ',') AS CHAR(500)),
         r.evidence_b_id = w.start_id
  FROM walk w
  JOIN evidence_relationship r ON r.evidence_a_id = w.current_id
  WHERE w.closes_loop = 0 AND w.depth < 8
    AND (LOCATE(CONCAT(',', r.evidence_b_id, ','), w.route) = 0 OR r.evidence_b_id = w.start_id)
)
SELECT e.evidence_no AS on_a_loop, w.depth AS loop_length, w.route
FROM walk w JOIN evidence e ON e.evidence_id = w.start_id
WHERE w.closes_loop = 1
ORDER BY e.evidence_no;

-- Q12. The same traversal packaged as a procedure (undirected, with access
--      check), exactly what the app calls. Run as administrator (user 1).
SET @tracex_user_id = 1;
CALL sp_linked_evidence(3, 6);

-- Q13. Keyword baseline for the retrieval experiments: MySQL FULLTEXT,
--      natural-language mode, on evidence and on findings.
SELECT 'evidence' AS kind, e.evidence_no AS ref, e.title,
       MATCH(e.title, e.description, e.extracted_text) AGAINST ('deleted backup copies ransom note') AS score
FROM evidence e
WHERE MATCH(e.title, e.description, e.extracted_text) AGAINST ('deleted backup copies ransom note')
UNION ALL
SELECT 'finding', CONCAT('finding ', f.finding_id), f.title,
       MATCH(f.title, f.description) AGAINST ('deleted backup copies ransom note')
FROM finding f
WHERE MATCH(f.title, f.description) AGAINST ('deleted backup copies ransom note')
ORDER BY score DESC
LIMIT 10;

-- Q14. Access control in action: the same question asked by two investigators.
--      The views filter by @tracex_user_id, so each sees only own cases.
SET @tracex_user_id = 3;   -- Isha
SELECT 'isha' AS who, case_number, status FROM v_my_cases;
SELECT 'isha' AS who, COUNT(*) AS visible_evidence FROM v_my_evidence;
SET @tracex_user_id = 5;   -- Lena (her access to case 4 was revoked)
SELECT 'lena' AS who, case_number, status FROM v_my_cases;
SELECT 'lena' AS who, COUNT(*) AS visible_evidence FROM v_my_evidence;

-- Q15. Audit trail of one evidence item (provenance in one query).
SELECT a.created_at, u.username, a.action, a.details
FROM audit_log a
LEFT JOIN app_user u ON u.user_id = a.user_id
WHERE a.entity_type = 'evidence' AND a.entity_id = 49
ORDER BY a.created_at;

-- Q16. Outbox health: how far Qdrant is behind MySQL.
SELECT operation, status, COUNT(*) AS jobs, MIN(created_at) AS oldest
FROM index_job
GROUP BY operation, status;

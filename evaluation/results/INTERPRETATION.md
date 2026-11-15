# TRACE-X Benchmark Interpretation

The November 2026 live benchmark compared keyword, vector-only and RRF hybrid retrieval across 500 and 2000 synthetic evidence records using 40 queries per dataset.

Vector-only retrieval outperformed hybrid on Precision@10, Recall@10, F1@10, MAP and NDCG@10 at both sizes. Hybrid narrowly led MRR at 500 records (0.855 versus 0.853), while vector-only led MRR at 2000 records (0.847 versus 0.813). Hybrid is therefore not universally superior.

The recorded environment used Windows, Node.js v22.19.0, Docker-hosted MySQL 8.0.46 and Qdrant. Result metadata identifies BAAI/bge-small-en-v1.5, kind=live and mock=false. See REPORT.md for full measurements and verification/ for unit and live test output.

These experiments use synthetic data and do not demonstrate completed UI/API integration or all rubric-required vector RUD operations.

// Qdrant access: collection setup/validation and point operations.
//
// Qdrant holds embeddings plus minimal metadata only. MySQL is the source of truth
// and decides who may see what: nothing returned from here is an authorization
// decision, and callers must re-check every hit against MySQL (v_my_evidence).

import { QdrantClient } from "@qdrant/js-client-rest";
import { VECTOR_DISTANCE, VECTOR_SIZE } from "./config.js";
import { VectorError, toQdrantError } from "./errors.js";
import { KINDS } from "./ids.js";

// Payload indexes from the design doc (section 5.3).
export const PAYLOAD_INDEXES = Object.freeze([
  { field: "case_id", schema: "integer" },
  { field: "kind", schema: "keyword" },
]);

export function createQdrantClient(config) {
  return new QdrantClient({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey,
    timeout: config.qdrantTimeoutMs,
    checkCompatibility: false,
  });
}

export function createVectorStore({ config, client = createQdrantClient(config) } = {}) {
  const name = config.collection;

  async function guard(action, fn) {
    try {
      return await fn();
    } catch (err) {
      throw toQdrantError(err, action);
    }
  }

  // Reads the collection and reports what is wrong with it. Never changes anything.
  async function inspectCollection() {
    return guard("read the collection", async () => {
      const { exists } = await client.collectionExists(name);
      if (!exists) return { exists: false, problems: [], indexes: {}, points: 0 };

      const info = await client.getCollection(name);
      const problems = [];
      const vectors = info?.config?.params?.vectors;
      // A single unnamed vector is {size, distance}; named vectors are an object of those.
      if (!vectors || typeof vectors.size !== "number") {
        problems.push("the collection does not use a single unnamed vector");
      } else {
        if (vectors.size !== VECTOR_SIZE) {
          problems.push(`vector size is ${vectors.size}, expected ${VECTOR_SIZE}`);
        }
        if (String(vectors.distance).toLowerCase() !== VECTOR_DISTANCE.toLowerCase()) {
          problems.push(`distance is ${vectors.distance}, expected ${VECTOR_DISTANCE}`);
        }
      }

      const schema = info?.payload_schema ?? {};
      const indexes = {};
      for (const { field, schema: want } of PAYLOAD_INDEXES) {
        const have = schema[field]?.data_type;
        indexes[field] = have ?? null;
        if (have && have !== want) {
          problems.push(`payload index "${field}" is ${have}, expected ${want}`);
        }
      }
      return {
        exists: true,
        problems,
        indexes,
        points: info?.points_count ?? 0,
        status: info?.status,
      };
    });
  }

  return {
    name,
    client,

    // Cheap reachability check.
    async ping() {
      return guard("be reached", async () => {
        await client.getCollections();
        return true;
      });
    },

    inspectCollection,

    // Creates the collection and payload indexes if missing; validates it if present.
    // It never deletes or recreates an existing collection: a mismatch is reported as an
    // error so that indexed data is not destroyed by accident.
    async ensureCollection() {
      let state = await inspectCollection();
      let created = false;
      if (!state.exists) {
        await guard("create the collection", () =>
          client.createCollection(name, {
            vectors: { size: VECTOR_SIZE, distance: VECTOR_DISTANCE },
          }),
        );
        created = true;
        state = await inspectCollection();
      }
      if (state.problems.length > 0) {
        throw new VectorError(
          "QDRANT_COLLECTION_MISMATCH",
          `Collection "${name}" does not match the design: ${state.problems.join("; ")}. Fix or drop it manually; it is never changed automatically.`,
          { status: 500 },
        );
      }
      const createdIndexes = [];
      for (const { field, schema } of PAYLOAD_INDEXES) {
        if (state.indexes[field]) continue;
        await guard("create a payload index", () =>
          client.createPayloadIndex(name, {
            field_name: field,
            field_schema: schema,
            wait: true,
          }),
        );
        createdIndexes.push(field);
      }
      return { created, createdIndexes };
    },

    // points = [{ id, vector, payload }]. Same id overwrites the same point.
    async upsertPoints(points) {
      if (!Array.isArray(points) || points.length === 0) return;
      for (const p of points) {
        if (!Array.isArray(p.vector) || p.vector.length !== VECTOR_SIZE) {
          throw new VectorError("VECTOR_INVALID_INPUT", "Point vector has the wrong size.", {
            status: 400,
          });
        }
      }
      await guard("store the vectors", () => client.upsert(name, { wait: true, points }));
    },

    // Deleting an id that does not exist is not an error (deletes are idempotent).
    async deletePoints(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return;
      await guard("delete the vectors", () =>
        client.delete(name, { wait: true, points: ids }),
      );
    },

    // Returns [{ id, score, payload }], best first. score = cosine similarity.
    //   caseIds: null/undefined = no case filter; [] = nothing (returns []); [..] = filter.
    // The case filter is a speed hint only. Callers still re-check access in MySQL.
    async search({ vector, caseIds, kind, limit = 20, scoreThreshold }) {
      if (!Array.isArray(vector) || vector.length !== VECTOR_SIZE) {
        throw new VectorError("VECTOR_INVALID_INPUT", "Query vector has the wrong size.", {
          status: 400,
        });
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new VectorError("VECTOR_INVALID_INPUT", "limit must be from 1 to 200.", {
          status: 400,
        });
      }
      if (kind !== undefined && !KINDS.includes(kind)) {
        throw new VectorError("VECTOR_INVALID_INPUT", `Unknown record kind "${kind}".`, {
          status: 400,
        });
      }
      if (Array.isArray(caseIds) && caseIds.length === 0) return [];

      const must = [];
      if (Array.isArray(caseIds)) {
        must.push({ key: "case_id", match: { any: caseIds } });
      }
      if (kind) must.push({ key: "kind", match: { value: kind } });

      // client.query is the current API (client.search was removed in client 1.20).
      const result = await guard("search", () =>
        client.query(name, {
          query: vector,
          limit,
          with_payload: true,
          with_vector: false,
          ...(must.length ? { filter: { must } } : {}),
          ...(scoreThreshold !== undefined ? { score_threshold: scoreThreshold } : {}),
        }),
      );
      return result.points.map((r) => ({
        id: String(r.id),
        score: r.score,
        payload: r.payload ?? null,
      }));
    },

    // One point's payload (no vector), or null. Used by the admin "vector index" view.
    async retrievePoint(id) {
      const rows = await guard("read the point", () =>
        client.retrieve(name, { ids: [id], with_payload: true, with_vector: false }),
      );
      const row = rows?.[0];
      return row ? { id: String(row.id), payload: row.payload ?? null } : null;
    },

    async countPoints() {
      const res = await guard("count points", () => client.count(name, { exact: true }));
      return res.count;
    },
  };
}

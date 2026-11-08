// Vector settings from environment variables. Nothing is read at import time, so
// `next build` works on a machine without a .env file. Error messages name the
// variable but never print its value (QDRANT_API_KEY in particular).

import { VectorError } from "./errors.js";

// Fixed by the design (docs/design/TRACE-X_Phase2_Design.md section 5).
export const VECTOR_SIZE = 384;
export const VECTOR_DISTANCE = "Cosine";
export const DEFAULT_COLLECTION = "tracex_records";
export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";

// Models the collection can hold. Each one must produce VECTOR_SIZE numbers.
// `onnxId` is the repository Transformers.js downloads (an ONNX conversion of the
// same model). It can be overridden with EMBEDDING_ONNX_MODEL.
export const SUPPORTED_MODELS = Object.freeze({
  "BAAI/bge-small-en-v1.5": {
    dimensions: 384,
    onnxId: "Xenova/bge-small-en-v1.5",
    pooling: "cls",
    maxTokens: 512,
  },
});

const COLLECTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function fail(message) {
  return new VectorError("VECTOR_CONFIG", `Vector configuration error: ${message}`, {
    status: 500,
  });
}

function readPositiveInt(env, name, fallback, max) {
  if (isBlank(env[name])) return fallback;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw fail(`${name} must be a whole number from 1 to ${max}.`);
  }
  return n;
}

export function loadVectorConfig(env = process.env) {
  if (isBlank(env.QDRANT_URL)) throw fail("missing environment variable QDRANT_URL.");
  let url;
  try {
    url = new URL(String(env.QDRANT_URL).trim());
  } catch {
    throw fail("QDRANT_URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw fail("QDRANT_URL must start with http:// or https://.");
  }
  if (url.username || url.password) {
    throw fail("QDRANT_URL must not contain credentials; use QDRANT_API_KEY.");
  }

  const collection = isBlank(env.QDRANT_COLLECTION)
    ? DEFAULT_COLLECTION
    : String(env.QDRANT_COLLECTION).trim();
  if (!COLLECTION_NAME.test(collection)) {
    throw fail("QDRANT_COLLECTION may contain only letters, digits, _ and - (max 64).");
  }

  const modelName = isBlank(env.EMBEDDING_MODEL)
    ? DEFAULT_EMBEDDING_MODEL
    : String(env.EMBEDDING_MODEL).trim();
  const model = SUPPORTED_MODELS[modelName];
  if (!model) {
    throw fail(
      `EMBEDDING_MODEL "${modelName}" is not supported. Supported: ${Object.keys(SUPPORTED_MODELS).join(", ")}.`,
    );
  }
  if (model.dimensions !== VECTOR_SIZE) {
    throw fail("the selected embedding model does not produce 384-dimensional vectors.");
  }

  return {
    qdrantUrl: url.toString().replace(/\/$/, ""),
    qdrantApiKey: isBlank(env.QDRANT_API_KEY) ? undefined : String(env.QDRANT_API_KEY),
    qdrantTimeoutMs: readPositiveInt(env, "QDRANT_TIMEOUT_MS", 10000, 120000),
    collection,
    embedding: {
      model: modelName,
      onnxId: isBlank(env.EMBEDDING_ONNX_MODEL)
        ? model.onnxId
        : String(env.EMBEDDING_ONNX_MODEL).trim(),
      pooling: model.pooling,
      maxTokens: model.maxTokens,
      dimensions: model.dimensions,
      cacheDir: isBlank(env.EMBEDDING_CACHE_DIR)
        ? undefined
        : String(env.EMBEDDING_CACHE_DIR).trim(),
      batchSize: readPositiveInt(env, "EMBEDDING_BATCH_SIZE", 16, 128),
    },
  };
}

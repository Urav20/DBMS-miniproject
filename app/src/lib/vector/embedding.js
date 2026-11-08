// Local embedding with BAAI/bge-small-en-v1.5 through Transformers.js (ONNX, CPU).
//
// - The model is loaded lazily on first use and only once (concurrent callers share
//   one load). A failed load is not cached, so the next call can retry.
// - Documents are embedded as-is; queries get the bge instruction prefix.
// - bge uses CLS pooling. Vectors are L2-normalized, so cosine similarity is a dot product.
// - Input beyond the 512-token limit is truncated by the tokenizer (one vector per
//   record; chunking is future work, per the design doc).
// - Every vector is checked: exactly 384 finite numbers, unit length.

import { VectorError } from "./errors.js";
import { QUERY_PREFIX } from "./text.js";

// Default loader. Imported on demand so that code which never embeds (for example
// the keyword-search route) does not pay for loading ONNX Runtime.
async function defaultLoadPipeline(embeddingConfig) {
  const transformers = await import("@huggingface/transformers");
  if (embeddingConfig.cacheDir) transformers.env.cacheDir = embeddingConfig.cacheDir;
  return transformers.pipeline("feature-extraction", embeddingConfig.onnxId, {
    dtype: "fp32",
  });
}

// Makes sure inputs are cut at `maxTokens` even if the downloaded tokenizer config does
// not declare model_max_length (Transformers.js then treats the limit as Infinity and
// would not truncate, and an over-long input would crash the model). Only the public
// tokenizer call signature is used. Safe to call twice: it wraps only once.
export function enforceMaxTokens(extractor, maxTokens) {
  const tokenizer = extractor?.tokenizer;
  if (typeof tokenizer !== "function" || tokenizer.tracexMaxTokens === maxTokens) {
    return extractor;
  }
  const limited = (texts, options = {}) =>
    tokenizer(texts, { ...options, truncation: true, max_length: maxTokens });
  Object.setPrototypeOf(limited, tokenizer); // other tokenizer properties still resolve
  limited.tracexMaxTokens = maxTokens;
  extractor.tokenizer = limited;
  return extractor;
}

function normalize(vec) {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return null;
  return vec.map((x) => x / norm);
}

function checkVector(vec, dimensions) {
  if (!Array.isArray(vec) || vec.length !== dimensions || !vec.every(Number.isFinite)) {
    throw new VectorError(
      "EMBEDDING_FAILED",
      `The embedding model returned an invalid vector (expected ${dimensions} numbers).`,
      { status: 500 },
    );
  }
  const unit = normalize(vec);
  if (!unit) {
    throw new VectorError("EMBEDDING_FAILED", "The embedding model returned a zero vector.", {
      status: 500,
    });
  }
  return unit;
}

export function createEmbedder({ config, loadPipeline = defaultLoadPipeline } = {}) {
  if (!config?.embedding) throw new Error("createEmbedder requires a vector config.");
  const { dimensions, batchSize, pooling } = config.embedding;
  let pending = null;

  function getExtractor() {
    if (!pending) {
      pending = Promise.resolve()
        .then(() => loadPipeline(config.embedding))
        .then((extractor) => enforceMaxTokens(extractor, config.embedding.maxTokens))
        .catch((cause) => {
          pending = null; // allow a retry
          throw new VectorError(
            "EMBEDDING_MODEL_UNAVAILABLE",
            "The embedding model could not be loaded. On the first run it must be downloaded; check the internet connection and EMBEDDING_ONNX_MODEL.",
            { status: 503, cause },
          );
        });
    }
    return pending;
  }

  function validateTexts(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new VectorError("VECTOR_INVALID_INPUT", "Provide at least one text to embed.", {
        status: 400,
      });
    }
    for (const t of texts) {
      if (typeof t !== "string" || t.trim() === "") {
        throw new VectorError("VECTOR_INVALID_INPUT", "Cannot embed an empty text.", {
          status: 400,
        });
      }
    }
  }

  async function run(texts) {
    const extractor = await getExtractor();
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      let rows;
      try {
        const tensor = await extractor(batch, { pooling, normalize: true });
        rows = tensor.tolist();
      } catch (cause) {
        throw new VectorError("EMBEDDING_FAILED", "The embedding model failed on this input.", {
          status: 500,
          cause,
        });
      }
      if (!Array.isArray(rows) || rows.length !== batch.length) {
        throw new VectorError(
          "EMBEDDING_FAILED",
          "The embedding model returned the wrong number of vectors.",
          { status: 500 },
        );
      }
      for (const row of rows) out.push(checkVector(row, dimensions));
    }
    return out;
  }

  return {
    dimensions,

    // Documents (evidence / findings): no prefix.
    async embedDocuments(texts) {
      validateTexts(texts);
      return run(texts);
    },

    // One search query: bge instruction prefix.
    async embedQuery(text) {
      validateTexts([text]);
      const [vec] = await run([QUERY_PREFIX + text.trim()]);
      return vec;
    },

    // Loads the model and embeds a short probe. Used by the health check.
    async probe() {
      const [vec] = await run(["TRACE-X embedding health check"]);
      return { dimensions: vec.length };
    },
  };
}

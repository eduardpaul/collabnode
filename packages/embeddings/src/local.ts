import type { EmbeddingProvider } from "@collabnode/graph";

/**
 * Output width per model, so a store can declare its vector column before the
 * model has ever been loaded. Pass `dimensions` explicitly for anything absent
 * from this list.
 */
const KNOWN_DIMENSIONS: Record<string, number> = {
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/bge-base-en-v1.5": 768,
  "Xenova/bge-large-en-v1.5": 1024,
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/multilingual-e5-small": 384,
};

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";

/**
 * bge and e5 are asymmetric: they expect this instruction in front of a short
 * search query and nothing in front of the stored passage. Skipping it costs
 * real retrieval quality, and applying it to documents costs the same.
 */
const DEFAULT_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/** Texts per forward pass. Large enough to amortize the call, small enough not to spike memory. */
const BATCH_SIZE = 32;

/**
 * Below this cosine similarity, treat two texts as unrelated.
 *
 * A vector index cannot say "nothing here": asked about something the graph
 * never mentions, it still returns its nearest note, and that reads as an
 * answer. Only a threshold stops it, and only the model knows its own scale.
 *
 * 0.5 is measured on bge-small-en-v1.5, and it is a judgement call rather than
 * a clean line: a full question against the note that answers it scores
 * 0.56-0.68 and an unrelated pair 0.42-0.46, but a terse question against a
 * short note can land at 0.49 — and so can an unrelated pair. The ranges
 * overlap, so no threshold separates them perfectly; this one errs towards
 * silence. Lower it to widen recall, raise it to stay quiet more often, or pass
 * 0 to keep every neighbour and judge the scores yourself.
 */
const DEFAULT_MIN_SIMILARITY = 0.5;

export interface LocalEmbeddingOptions {
  /** Hugging Face model id. Defaults to bge-small-en-v1.5 — 384 dims, ~30 MB quantized. */
  model?: string;
  /** Required for a model not in the known-dimensions list. */
  dimensions?: number;
  /** ONNX weight precision. `q8` keeps the download small; `fp32` is more faithful. */
  dtype?: string;
  /** bge/e5 want `cls`; sentence-transformers models like MiniLM want `mean`. */
  pooling?: "cls" | "mean";
  /** Prefix applied to queries only. Pass "" for a symmetric model. */
  queryPrefix?: string;
  /** Cosine similarity below which a hit is treated as unrelated. Pass 0 to keep every neighbour. */
  minSimilarity?: number;
}

interface FeatureExtractor {
  (
    texts: string[],
    options: { pooling: string; normalize: boolean },
  ): Promise<{ tolist(): number[][] }>;
}

function requireDimensions(model: string, override: number | undefined): number {
  const dimensions = override ?? KNOWN_DIMENSIONS[model];
  if (!dimensions) {
    throw new Error(
      `[collabnode] unknown embedding width for "${model}". Pass localEmbeddings({ model, dimensions }).`,
    );
  }
  return dimensions;
}

async function loadPipeline(model: string, dtype: string): Promise<FeatureExtractor> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import("@huggingface/transformers")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `[collabnode] semantic search needs transformers.js. Install it with \`pnpm add @huggingface/transformers\`, or leave \`embeddings\` unset to stay on full-text search. ${String(error)}`,
    );
  }
  const pipeline = mod.pipeline as
    | ((task: string, model: string, options: { dtype: string }) => Promise<FeatureExtractor>)
    | undefined;
  if (!pipeline) {
    throw new Error("[collabnode] @huggingface/transformers does not export `pipeline`");
  }
  return pipeline("feature-extraction", model, { dtype });
}

/**
 * A local embedding provider backed by transformers.js — no API key, no network
 * after the first run, and nothing leaves the machine.
 *
 * The model is downloaded on first use (~30 MB for the default) and cached by
 * transformers.js; loading is lazy and shared, so a process that never embeds
 * never pays for it.
 */
export function localEmbeddings(options: LocalEmbeddingOptions = {}): EmbeddingProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const dimensions = requireDimensions(model, options.dimensions);
  const dtype = options.dtype ?? "q8";
  const pooling = options.pooling ?? "cls";
  const queryPrefix = options.queryPrefix ?? DEFAULT_QUERY_PREFIX;
  let extractor: Promise<FeatureExtractor> | undefined;

  const load = (): Promise<FeatureExtractor> => {
    // Cached as a promise, not an awaited value, so concurrent first writes
    // load one model rather than racing to load several.
    extractor ??= loadPipeline(model, dtype);
    return extractor;
  };

  return {
    id: model,
    dimensions,
    minSimilarity: options.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
    async warm(): Promise<void> {
      await load();
    },
    async embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
      if (texts.length === 0) {
        return [];
      }
      const extract = await load();
      const prepared = texts.map((text) => {
        // A pooled embedding of the empty string is meaningless but the
        // tokenizer still rejects it, so give it something to chew on.
        const body = text.trim() || " ";
        return kind === "query" ? `${queryPrefix}${body}` : body;
      });
      const out: Float32Array[] = [];
      for (let start = 0; start < prepared.length; start += BATCH_SIZE) {
        const batch = prepared.slice(start, start + BATCH_SIZE);
        const result = await extract(batch, { pooling, normalize: true });
        for (const row of result.tolist()) {
          out.push(Float32Array.from(row));
        }
      }
      return out;
    },
  };
}

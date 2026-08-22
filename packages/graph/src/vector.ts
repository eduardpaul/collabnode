import type { NodeTypeDef } from "@collabnode/schema";
import type { PropertyMap } from "./ops.js";
import type { GraphSearchHit } from "./search.js";
import { flattenSearchValue } from "./search.js";

/**
 * Turns text into vectors. Implemented outside this package — see
 * `@collabnode/embeddings` for the local transformers.js one — so that a store
 * can index meaning without every consumer inheriting an ONNX runtime.
 */
export interface EmbeddingProvider {
  /**
   * Stable model id, e.g. `Xenova/bge-small-en-v1.5`. Backends bake it into
   * their column and index names, so switching models is detectable rather
   * than silently comparing vectors from two different embedding spaces.
   */
  readonly id: string;
  /** Length of every vector this provider returns. */
  readonly dimensions: number;
  /**
   * Embed a batch, in order.
   *
   * `kind` exists because asymmetric retrieval models — bge and e5 among them —
   * want a fixed instruction prefixed to the *query* and nothing prefixed to
   * the stored document. Providers that do not care may ignore it.
   */
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
  /**
   * Cosine similarity below which two texts are unrelated *in this model's
   * space*, if the model has a usable one.
   *
   * A vector index has no notion of "no match": asked about something the graph
   * says nothing about, it still hands back its nearest neighbours. Only the
   * provider knows where its own scale stops meaning anything — bge-small puts
   * unrelated English around 0.42 and related text above 0.55, numbers that
   * would be nonsense for another model. Omitted means no absolute floor, and
   * callers fall back to comparing hits against each other.
   */
  readonly minSimilarity?: number;
  /** Load the model ahead of first use, so a user-facing write does not pay for it. */
  warm?(): Promise<void>;
  close?(): Promise<void>;
}

export interface GraphVectorRequest {
  /** Free text to embed and rank against. Exactly one of `q` / `likeId`. */
  q?: string;
  /** Rank against this node's own stored vector — "more things like this one". */
  likeId?: string;
  /** Restrict to these node types. Omitted means every type. */
  types?: string[];
  limit: number;
}

/** Properties of one node type that the schema marked `vector: true`, in schema order. */
export function vectorProperties(def: NodeTypeDef | undefined): string[] {
  if (!def) {
    return [];
  }
  return Object.entries(def.properties)
    .filter(([, property]) => property.vector?.index)
    .map(([name]) => name);
}

/**
 * The single document embedded for one node: its vectorized fields joined in
 * schema order.
 *
 * One vector per node rather than one per field, because a vector index lives
 * on a column and a node write should cost one embedding, not one per property.
 * The cost is that a long body dilutes a short title, and that text past the
 * model's context window is dropped — chunking is deliberately out of scope.
 */
export function vectorText(def: NodeTypeDef | undefined, properties: PropertyMap): string {
  const parts: string[] = [];
  for (const name of vectorProperties(def)) {
    const text = flattenSearchValue(properties[name]).trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

/**
 * Cosine similarity in [-1, 1], higher is closer.
 *
 * Providers are expected to return normalized vectors, which would make this a
 * plain dot product, but normalizing here costs one pass and keeps a provider
 * that forgets from silently ranking by magnitude.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    normA += (a[i] as number) ** 2;
    normB += (b[i] as number) ** 2;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / Math.sqrt(normA * normB);
}

/** A provider id reduced to something usable as a column or index name. */
export function vectorSlug(providerId: string): string {
  return providerId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Drop hits the provider considers unrelated, when it has an opinion. */
export function aboveFloor(
  hits: GraphSearchHit[],
  provider: EmbeddingProvider | undefined,
): GraphSearchHit[] {
  const floor = provider?.minSimilarity;
  return floor === undefined ? hits : hits.filter((hit) => hit.score >= floor);
}

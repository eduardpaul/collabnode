import type { GraphSchema } from "@collabnode/schema";
import type {
  EntityMeta,
  GraphEdgeRecord,
  GraphNodeRecord,
  GraphOp,
  PropertyMap,
  QueryResult,
} from "./ops.js";
import { emptyMeta } from "./ops.js";
import { runMinimalQuery } from "./query.js";
import {
  flattenSearchValue,
  searchTerms,
  searchableProperties,
  type GraphSearchHit,
  type GraphSearchRequest,
} from "./search.js";
import {
  GraphStoreError,
  scopeKey,
  type GraphSearchModes,
  type GraphStore,
  type WorkspaceScope,
} from "./store.js";
import {
  aboveFloor,
  cosineSimilarity,
  vectorProperties,
  vectorText,
  type EmbeddingProvider,
  type GraphVectorRequest,
} from "./vector.js";

function cloneProps(properties: PropertyMap): PropertyMap {
  return { ...properties };
}

function cloneTags(tags: string[] | undefined): string[] | undefined {
  return tags ? [...tags] : undefined;
}

function cloneMeta(meta: EntityMeta | undefined): EntityMeta {
  return { ...(meta ?? emptyMeta()) };
}

export interface InMemoryGraphStoreOptions {
  /** Without one, `searchVector` reports no index and search stays lexical. */
  embeddings?: EmbeddingProvider;
}

/** The vector, plus the text it was made from, so an unchanged node is not re-embedded. */
interface StoredVector {
  text: string;
  vector: Float32Array;
}

/** One workspace's projection. Nothing here is shared with any other scope. */
interface Partition {
  schema: GraphSchema;
  nodes: Map<string, GraphNodeRecord>;
  edges: Map<string, GraphEdgeRecord>;
  vectors: Map<string, StoredVector>;
}

function emptyPartition(schema: GraphSchema): Partition {
  return { schema, nodes: new Map(), edges: new Map(), vectors: new Map() };
}

/**
 * One store, many workspaces.
 *
 * The partition map is the whole of the scoping story: everything a projection
 * owns lives inside a `Partition`, so `dropScope` is a single delete and no
 * read path can reach across workspaces by accident.
 */
export class InMemoryGraphStore implements GraphStore {
  private readonly partitions = new Map<string, Partition>();
  private readonly embeddings: EmbeddingProvider | undefined;
  private embedFailed = false;

  constructor(options: InMemoryGraphStoreOptions = {}) {
    this.embeddings = options.embeddings;
  }

  async applySchema(scope: WorkspaceScope, schema: GraphSchema): Promise<void> {
    // Replacing the partition resets *this* workspace only. The previous
    // per-store version cleared everything, which is invisible when a store
    // serves one document and silently destructive when it serves many.
    this.partitions.set(scopeKey(scope), emptyPartition(schema));
    if (this.vectorized(schema)) {
      // Started, not awaited: loading a model takes seconds and this is on the
      // path that opens a document. Failures surface at the first embed, which
      // reports them once - there is nothing to say here that is not said there.
      void this.embeddings?.warm?.().catch(() => {});
    }
  }

  async apply(scope: WorkspaceScope, op: GraphOp): Promise<void> {
    await this.applyBatch(scope, [op]);
  }

  async applyBatch(scope: WorkspaceScope, ops: GraphOp[]): Promise<void> {
    const partition = this.require(scope);
    for (const op of ops) {
      mutate(partition, op);
    }
    // One embed call for the whole batch: seeding a document should not be one
    // model round-trip per node.
    await this.embedNodes(partition, ops);
  }

  async dropScope(scope: WorkspaceScope): Promise<void> {
    this.partitions.delete(scopeKey(scope));
  }

  private require(scope: WorkspaceScope): Partition {
    const partition = this.partitions.get(scopeKey(scope));
    if (!partition) {
      throw new GraphStoreError(
        `applySchema must be called for workspace '${scope.workspaceId}' before it is used`,
      );
    }
    return partition;
  }

  /** True when the schema asks for embeddings and a provider exists to make them. */
  private vectorized(schema: GraphSchema | undefined): boolean {
    if (!schema || !this.embeddings) {
      return false;
    }
    return Object.values(schema.nodes).some((def) => vectorProperties(def).length > 0);
  }

  /**
   * Embed the nodes these ops touched, skipping any whose vectorized text is
   * unchanged. A provider failure costs the index, not the write: the node is
   * already stored, and the missing vector only means it cannot be reached
   * semantically until it is written again.
   */
  private async embedNodes(partition: Partition, ops: GraphOp[]): Promise<void> {
    const provider = this.embeddings;
    if (!provider || !this.vectorized(partition.schema)) {
      return;
    }
    const pending: Array<{ id: string; text: string }> = [];
    for (const op of ops) {
      if (op.kind !== "upsertNode") {
        continue;
      }
      const node = partition.nodes.get(op.id);
      if (!node) {
        continue;
      }
      const text = vectorText(partition.schema.nodes[node.type], node.properties);
      if (!text) {
        partition.vectors.delete(node.id);
        continue;
      }
      if (partition.vectors.get(node.id)?.text !== text) {
        pending.push({ id: node.id, text });
      }
    }
    if (pending.length === 0) {
      return;
    }
    try {
      const vectors = await provider.embed(
        pending.map((item) => item.text),
        "document",
      );
      pending.forEach((item, index) => {
        const vector = vectors[index];
        if (vector) {
          partition.vectors.set(item.id, { text: item.text, vector });
        }
      });
    } catch (error) {
      if (!this.embedFailed) {
        this.embedFailed = true;
        console.warn(`[collabnode] embedding failed, semantic search is incomplete: ${String(error)}`);
      }
    }
  }

  async query(scope: WorkspaceScope, cypher: string): Promise<QueryResult> {
    const partition = this.require(scope);
    return runMinimalQuery(cypher, partition.nodes, partition.edges);
  }

  /**
   * The same contract the database backends serve from a real full-text index,
   * answered here by a scan. A collaborative document holds what one CRDT holds,
   * and the substring scan this replaces was already linear, so there is nothing
   * to gain from maintaining an index - and one whole class of sync bug to lose.
   *
   * Scoring is deliberately plain: each distinct query term that a field
   * contains adds that field's schema boost, once. No term-frequency reward,
   * so a body that repeats a word cannot climb over the field named after it.
   */
  async search(
    scope: WorkspaceScope,
    request: GraphSearchRequest,
  ): Promise<GraphSearchHit[] | undefined> {
    const partition = this.partitions.get(scopeKey(scope));
    if (!partition) {
      return undefined;
    }
    const terms = new Set(searchTerms(request.q));
    if (terms.size === 0) {
      return [];
    }
    const hits: GraphSearchHit[] = [];
    for (const node of partition.nodes.values()) {
      if (request.types && !request.types.includes(node.type)) {
        continue;
      }
      const score = scoreNode(partition.schema, node, terms);
      if (score > 0) {
        hits.push({ id: node.id, score });
      }
    }
    // Ties break on id so paging over an unchanged graph is stable.
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, request.limit);
  }

  /**
   * Nearest neighbours by cosine similarity, brute force over every stored
   * vector. Same reasoning as `search`: a CRDT document is small enough that a
   * scan beats an HNSW index nobody has to keep in sync.
   */
  async searchVector(
    scope: WorkspaceScope,
    request: GraphVectorRequest,
  ): Promise<GraphSearchHit[] | undefined> {
    const partition = this.partitions.get(scopeKey(scope));
    if (!partition || !this.vectorized(partition.schema)) {
      return undefined;
    }
    const query = await this.queryVector(partition, request);
    if (!query) {
      return undefined;
    }
    const hits: GraphSearchHit[] = [];
    for (const [id, stored] of partition.vectors) {
      // "More like this" means other things, not the thing itself.
      if (id === request.likeId) {
        continue;
      }
      const node = partition.nodes.get(id);
      if (!node || (request.types && !request.types.includes(node.type))) {
        continue;
      }
      hits.push({ id, score: cosineSimilarity(query, stored.vector) });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return aboveFloor(hits, this.embeddings).slice(0, request.limit);
  }

  /** The vector to rank against: a node's own, or a freshly embedded query string. */
  private async queryVector(
    partition: Partition,
    request: GraphVectorRequest,
  ): Promise<Float32Array | undefined> {
    if (request.likeId !== undefined) {
      return partition.vectors.get(request.likeId)?.vector;
    }
    const text = request.q?.trim();
    if (!text) {
      return undefined;
    }
    try {
      return (await this.embeddings?.embed([text], "query"))?.[0];
    } catch (error) {
      console.warn(`[collabnode] could not embed the query, falling back: ${String(error)}`);
      return undefined;
    }
  }

  searchModes(scope: WorkspaceScope): GraphSearchModes {
    const partition = this.partitions.get(scopeKey(scope));
    return { text: partition !== undefined, vector: this.vectorized(partition?.schema) };
  }

  getNode(scope: WorkspaceScope, id: string): GraphNodeRecord | undefined {
    const node = this.partitions.get(scopeKey(scope))?.nodes.get(id);
    return node
      ? {
          ...node,
          properties: cloneProps(node.properties),
          tags: cloneTags(node.tags),
          meta: cloneMeta(node.meta),
        }
      : undefined;
  }

  getEdge(scope: WorkspaceScope, id: string): GraphEdgeRecord | undefined {
    const edge = this.partitions.get(scopeKey(scope))?.edges.get(id);
    return edge
      ? { ...edge, properties: cloneProps(edge.properties), meta: cloneMeta(edge.meta) }
      : undefined;
  }

  async close(): Promise<void> {
    this.partitions.clear();
  }
}

function mutate(partition: Partition, op: GraphOp): void {
  switch (op.kind) {
    case "upsertNode": {
      const existing = partition.nodes.get(op.id);
      partition.nodes.set(op.id, {
        id: op.id,
        type: op.type,
        properties: cloneProps(op.properties),
        tags: op.tags !== undefined ? [...op.tags] : cloneTags(existing?.tags),
        meta: cloneMeta(op.meta),
      });
      break;
    }
    case "deleteNode":
      partition.nodes.delete(op.id);
      partition.vectors.delete(op.id);
      for (const [edgeId, edge] of partition.edges) {
        if (edge.from === op.id || edge.to === op.id) {
          partition.edges.delete(edgeId);
        }
      }
      break;
    case "upsertEdge":
      partition.edges.set(op.id, {
        id: op.id,
        type: op.type,
        from: op.from,
        to: op.to,
        properties: cloneProps(op.properties),
        meta: cloneMeta(op.meta),
      });
      break;
    case "deleteEdge":
      partition.edges.delete(op.id);
      break;
    default: {
      const _never: never = op;
      throw new GraphStoreError(`unknown op: ${JSON.stringify(_never)}`);
    }
  }
}

function scoreNode(schema: GraphSchema, node: GraphNodeRecord, terms: Set<string>): number {
  const fields = searchableProperties(schema.nodes[node.type]);
  let score = 0;
  for (const { name, boost } of fields) {
    const value = node.properties[name];
    if (value === undefined || value === null) {
      continue;
    }
    const fieldTerms = new Set(searchTerms(flattenSearchValue(value)));
    for (const term of terms) {
      if (fieldTerms.has(term)) {
        score += boost;
      }
    }
  }
  for (const tag of node.tags ?? []) {
    const tagTerms = new Set(searchTerms(tag));
    for (const term of terms) {
      if (tagTerms.has(term)) {
        score += 1;
      }
    }
  }
  return score;
}

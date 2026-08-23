import {
  squash,
  type GraphEdgeRecord,
  type GraphNodeRecord,
  type GraphOp,
  type GraphSnapshot,
} from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";

const SEP = "\0";

/**
 * Lookup tables over one snapshot, built once and reused for a whole batch.
 *
 * Every write used to answer "does this already exist?" by scanning the
 * snapshot's node array - by id, by identity hash, and again for a normalized
 * near-miss - which is what made seeding a template super-linear: 261 us per
 * node at 25 nodes and 1070 us at 800. The scans are the same questions asked
 * repeatedly of an unchanging structure, so the structure is indexed instead.
 *
 * The index is mutable on purpose. A batch that creates a column and then a
 * card pointing at it must see its own earlier writes, so planned ops are
 * absorbed as they are produced rather than after the batch commits.
 */
export class SnapshotIndex {
  private readonly nodes = new Map<string, GraphNodeRecord>();
  private readonly edges = new Map<string, GraphEdgeRecord>();
  /** Squashed identity values -> nodes sharing them. Several means "cannot tell". */
  private readonly normalized = new Map<string, GraphNodeRecord[]>();
  /**
   * Singleton type -> the node standing in for it, if the document already has
   * one. Only types declared `singleton:` are tracked, so this stays a handful
   * of entries rather than an index of the whole graph.
   */
  private readonly singletons = new Map<string, GraphNodeRecord>();
  /** type + endpoints -> edge, so an edge is not duplicated per re-run. */
  private readonly byEndpoints = new Map<string, GraphEdgeRecord>();

  constructor(
    private readonly schema: GraphSchema,
    snapshot: GraphSnapshot,
  ) {
    for (const node of snapshot.nodes) {
      this.addNode(node);
    }
    for (const edge of snapshot.edges) {
      this.addEdge(edge);
    }
  }

  node(id: string): GraphNodeRecord | undefined {
    return this.nodes.get(id);
  }

  edge(id: string): GraphEdgeRecord | undefined {
    return this.edges.get(id);
  }

  /**
   * The single node whose identity fields differ only in case, accent, or
   * punctuation. Two candidates means we cannot tell which was meant, so the
   * caller creates rather than guessing.
   */
  normalizedMatch(type: string, properties: Record<string, unknown>): GraphNodeRecord | undefined {
    const key = this.normalizedKey(type, properties);
    if (key === undefined) {
      return undefined;
    }
    const matches = this.normalized.get(key);
    return matches?.length === 1 ? matches[0] : undefined;
  }

  /**
   * The node a `singleton:` type already has, whatever its id.
   *
   * Normally that is the derived id, but a document written before the type was
   * declared singleton — or seeded from an artifact — holds one under some other
   * id, and adopting it is what keeps the next write an update instead of a
   * second node.
   */
  singletonOfType(type: string): GraphNodeRecord | undefined {
    return this.singletons.get(type);
  }

  edgeByEndpoints(type: string, from: string, to: string): GraphEdgeRecord | undefined {
    const direct = this.byEndpoints.get(endpointKey(type, from, to));
    if (direct) {
      return direct;
    }
    if (this.schema.edges[type]?.directed === false) {
      // An undirected edge is the same edge read the other way round.
      const swapped = endpointKey(type, to, from);
      return this.byEndpoints.get(swapped);
    }
    return undefined;
  }

  /** Fold a planned op in, so later ops in the same batch resolve against it. */
  absorb(op: GraphOp): void {
    switch (op.kind) {
      case "upsertNode": {
        const existing = this.nodes.get(op.id);
        if (existing) {
          this.removeNormalized(existing);
        }
        this.addNode({
          id: op.id,
          type: op.type,
          properties: { ...existing?.properties, ...op.properties },
          tags: op.tags ?? existing?.tags,
          meta: op.meta,
        });
        break;
      }
      case "deleteNode": {
        const existing = this.nodes.get(op.id);
        if (existing) {
          this.removeNormalized(existing);
          this.nodes.delete(op.id);
          if (this.singletons.get(existing.type)?.id === op.id) {
            this.singletons.delete(existing.type);
          }
        }
        for (const [id, edge] of this.edges) {
          if (edge.from === op.id || edge.to === op.id) {
            this.edges.delete(id);
            this.byEndpoints.delete(endpointKey(edge.type, edge.from, edge.to));
          }
        }
        break;
      }
      case "upsertEdge":
        this.addEdge({
          id: op.id,
          type: op.type,
          from: op.from,
          to: op.to,
          properties: op.properties,
          meta: op.meta,
        });
        break;
      case "deleteEdge": {
        const existing = this.edges.get(op.id);
        if (existing) {
          this.edges.delete(op.id);
          this.byEndpoints.delete(endpointKey(existing.type, existing.from, existing.to));
        }
        break;
      }
    }
  }

  private addNode(node: GraphNodeRecord): void {
    this.nodes.set(node.id, node);
    if (this.schema.nodes[node.type]?.singleton) {
      const current = this.singletons.get(node.type);
      // First one wins, and stays won: adopting the earliest node is what makes
      // the type single. Re-adding the same id refreshes it, so a later write in
      // the same batch merges against its own earlier one.
      if (!current || current.id === node.id) {
        this.singletons.set(node.type, node);
      }
    }
    const key = this.normalizedKey(node.type, node.properties);
    if (key === undefined) {
      return;
    }
    const bucket = this.normalized.get(key);
    if (bucket) {
      bucket.push(node);
    } else {
      this.normalized.set(key, [node]);
    }
  }

  private removeNormalized(node: GraphNodeRecord): void {
    const key = this.normalizedKey(node.type, node.properties);
    if (key === undefined) {
      return;
    }
    const bucket = this.normalized.get(key);
    if (!bucket) {
      return;
    }
    const next = bucket.filter((candidate) => candidate.id !== node.id);
    if (next.length === 0) {
      this.normalized.delete(key);
    } else {
      this.normalized.set(key, next);
    }
  }

  private addEdge(edge: GraphEdgeRecord): void {
    this.edges.set(edge.id, edge);
    this.byEndpoints.set(endpointKey(edge.type, edge.from, edge.to), edge);
  }

  private normalizedKey(type: string, properties: Record<string, unknown>): string | undefined {
    const fields = this.schema.nodes[type]?.identity?.from;
    if (!fields || fields.length === 0) {
      return undefined;
    }
    const parts: string[] = [];
    for (const field of fields) {
      const value = squash(String(properties[field] ?? ""));
      if (value === "") {
        return undefined;
      }
      parts.push(value);
    }
    return `${type}${SEP}${parts.join(SEP)}`;
  }
}

/**
 * Parameters are named for their position rather than for direction: an
 * undirected edge is looked up both ways round, and `from`/`to` here would read
 * as a mistake at the second call site rather than as the point of it.
 */
function endpointKey(type: string, tail: string, head: string): string {
  return `${type}${SEP}${tail}${SEP}${head}`;
}

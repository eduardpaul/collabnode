import type { AnyGraph, GraphSnapshot, GraphTypeMap, NodeLike } from "@collabnode/graph";
import type { NodeNameOf } from "@collabnode/schema";
import { walk } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import { ALL_NODE_TYPES } from "@collabnode/schema";
import { nodeLabel } from "./tools-format.js";

export interface SnapshotMarkdownOptions<S extends GraphTypeMap = AnyGraph> {
  /** Whether to output node properties below the title. Defaults to true. */
  includeProperties?: boolean;
  /** Filter to only include specific node types. */
  types?: readonly NodeNameOf<S>[];
  /** Only these node ids. Combined with `types` if both are set. */
  ids?: string[];
  /**
   * When `ids` is set, also include 1-hop neighbors of those nodes (both
   * directions, every edge type). Defaults to false.
   */
  includeNeighbors?: boolean;
  /**
   * Print a Relationships section. Defaults to true. When `ids` is set, only
   * edges incident to the selected nodes are included; otherwise every edge.
   */
  includeEdges?: boolean;
  /** Maximum number of nodes to include. Defaults to 100. */
  maxNodes?: number;
  /** Group nodes by their node type. Defaults to true. */
  groupByType?: boolean;
  /**
   * Per-node-type field projection: only these properties are printed for nodes
   * of that type, in the order given. A type absent from the map keeps every
   * property; `*` is the fallback for types not named. Omit the option entirely
   * for the historical behaviour of printing everything.
   */
  fields?: { [T in NodeNameOf<S> | typeof ALL_NODE_TYPES]?: readonly string[] };
  /**
   * When given, node headings use the schema's `ui.label` template instead of
   * guessing `title || name || id`. Opt-in so existing callers are unchanged.
   */
  schema?: GraphSchema;
  /**
   * Exactly which edges to print, by id. Callers that have already decided the
   * edge set — a resolved view, say — pass it here rather than letting the
   * `ids` heuristic below re-derive a looser one and print relationships whose
   * endpoints are not in the output.
   */
  edgeIds?: string[];
}

/**
 * The property names to print for one node type, in order, or `undefined` for
 * "every property this node happens to carry".
 */
function fieldsFor(
  options: SnapshotMarkdownOptions,
  type: string,
): readonly string[] | undefined {
  if (!options.fields) {
    return undefined;
  }
  return options.fields[type] ?? options.fields[ALL_NODE_TYPES];
}

/** The heading for one node: schema label when we have a schema, else a guess. */
function headingFor(options: SnapshotMarkdownOptions, node: NodeLike): string {
  if (options.schema) {
    return nodeLabel(options.schema, node);
  }
  return String(node.properties.title || node.properties.name || node.id);
}

/**
 * The property lines under one node heading.
 *
 * `title` and `name` are always skipped: the heading is already built from them,
 * and repeating them costs a line per node in a format whose whole point is to
 * be cheap to read. A projection may still name them — a UI wants `title` as a
 * column — and this rendering just declines to print them twice.
 */
function propertyLines(options: SnapshotMarkdownOptions, node: NodeLike): string[] {
  const selected = fieldsFor(options, node.type);
  const entries = (
    selected
      ? selected.map((key) => [key, node.properties[key]] as const)
      : Object.entries(node.properties)
  ).filter(([k]) => k !== "title" && k !== "name");

  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const valStr = typeof value === "object" ? JSON.stringify(value) : String(value);
    lines.push(`  - *${key}*: ${valStr}`);
  }
  return lines;
}

function selectNodes<S extends GraphTypeMap>(
  snapshot: GraphSnapshot<S>,
  options: SnapshotMarkdownOptions<S>,
): GraphSnapshot<S>["nodes"] {
  const typeSet = options.types && options.types.length > 0 ? new Set(options.types) : undefined;
  let nodes = snapshot.nodes;

  if (options.ids) {
    const allowed = new Set(options.ids.filter((id) => snapshot.nodes.some((n) => n.id === id)));
    if (options.includeNeighbors) {
      for (const id of [...allowed]) {
        for (const hop of walk(snapshot, id, { direction: "both", depth: 1 }).hops) {
          allowed.add(hop.node.id);
        }
      }
    }
    nodes = snapshot.nodes.filter((n) => allowed.has(n.id));
  }

  if (typeSet) {
    nodes = nodes.filter((n) => typeSet.has(n.type));
  }
  return nodes;
}

/**
 * Serializes a Collabnode GraphSnapshot into clean, token-efficient Markdown
 * suitable for LLM prompts, agent context, or documentation.
 */
export function snapshotToMarkdown<S extends GraphTypeMap = AnyGraph>(
  snapshot: GraphSnapshot<S>,
  options: SnapshotMarkdownOptions<S> = {},
): string {
  const { includeProperties = true, maxNodes = 100, groupByType = true, includeEdges = true } = options;

  let nodes = selectNodes(snapshot, options);
  if (nodes.length > maxNodes) {
    nodes = nodes.slice(0, maxNodes);
  }
  const selectedIds = new Set(nodes.map((n) => n.id));
  const subgraph = options.ids !== undefined;
  let edges: GraphSnapshot<S>["edges"];
  if (!includeEdges) {
    edges = [];
  } else if (options.edgeIds) {
    const wanted = new Set(options.edgeIds);
    edges = snapshot.edges.filter((e) => wanted.has(e.id));
  } else if (subgraph) {
    edges = snapshot.edges.filter((e) => selectedIds.has(e.from) || selectedIds.has(e.to));
  } else {
    edges = snapshot.edges;
  }

  if (nodes.length === 0 && edges.length === 0) {
    return "*(Empty graph)*";
  }

  const lines: string[] = [];

  if (groupByType) {
    const grouped = new Map<string, typeof nodes>();
    for (const node of nodes) {
      const list = grouped.get(node.type) ?? [];
      list.push(node);
      grouped.set(node.type, list);
    }

    for (const [type, groupNodes] of grouped.entries()) {
      lines.push(`### ${type} (${groupNodes.length})`);
      for (const n of groupNodes) {
        lines.push(`- **${headingFor(options, n)}** (\`id: ${n.id}\`)`);
        if (includeProperties) {
          lines.push(...propertyLines(options, n));
        }
      }
      lines.push("");
    }
  } else {
    lines.push(`### Nodes (${nodes.length})`);
    for (const n of nodes) {
      lines.push(`- [${n.type}] **${headingFor(options, n)}** (\`id: ${n.id}\`)`);
    }
    lines.push("");
  }

  if (edges.length > 0) {
    lines.push(`### Relationships (${edges.length})`);
    for (const edge of edges.slice(0, maxNodes)) {
      lines.push(`- \`${edge.from}\` --[${edge.type}]--> \`${edge.to}\``);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Compares two snapshots and produces a human/LLM-friendly Markdown summary of changes.
 */
export function diffSnapshotsToMarkdown<S extends GraphTypeMap = AnyGraph>(
  previous: GraphSnapshot<S>,
  next: GraphSnapshot<S>,
): string {
  const prevNodes = new Map(previous.nodes.map((n) => [n.id, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]));
  const prevEdges = new Map(previous.edges.map((e) => [e.id, e]));
  const nextEdges = new Map(next.edges.map((e) => [e.id, e]));

  const addedNodes: string[] = [];
  const modifiedNodes: string[] = [];
  const deletedNodes: string[] = [];

  for (const [id, node] of nextNodes) {
    const before = prevNodes.get(id);
    const title = node.properties.title || node.properties.name || id;
    if (!before) {
      addedNodes.push(`+ [${node.type}] **${title}** (\`id: ${id}\`)`);
    } else {
      const propChanges: string[] = [];
      const allKeys = new Set([...Object.keys(before.properties), ...Object.keys(node.properties)]);
      for (const k of allKeys) {
        const vBefore = before.properties[k];
        const vAfter = node.properties[k];
        if (JSON.stringify(vBefore) !== JSON.stringify(vAfter)) {
          propChanges.push(`${k}: ${JSON.stringify(vBefore)} → ${JSON.stringify(vAfter)}`);
        }
      }
      if (propChanges.length > 0) {
        modifiedNodes.push(`~ [${node.type}] **${title}** (\`id: ${id}\`): ${propChanges.join(", ")}`);
      }
    }
  }

  for (const [id, before] of prevNodes) {
    if (!nextNodes.has(id)) {
      const title = before.properties.title || before.properties.name || id;
      deletedNodes.push(`- [${before.type}] **${title}** (\`id: ${id}\`)`);
    }
  }

  const addedEdges: string[] = [];
  const deletedEdges: string[] = [];

  for (const [id, edge] of nextEdges) {
    if (!prevEdges.has(id)) {
      addedEdges.push(`+ \`${edge.from}\` --[${edge.type}]--> \`${edge.to}\``);
    }
  }

  for (const [id, edge] of prevEdges) {
    if (!nextEdges.has(id)) {
      deletedEdges.push(`- \`${edge.from}\` --[${edge.type}]--> \`${edge.to}\``);
    }
  }

  const sections: string[] = [];

  if (addedNodes.length > 0) {
    sections.push(`**Added Nodes (${addedNodes.length}):**\n${addedNodes.join("\n")}`);
  }
  if (modifiedNodes.length > 0) {
    sections.push(`**Modified Nodes (${modifiedNodes.length}):**\n${modifiedNodes.join("\n")}`);
  }
  if (deletedNodes.length > 0) {
    sections.push(`**Deleted Nodes (${deletedNodes.length}):**\n${deletedNodes.join("\n")}`);
  }
  if (addedEdges.length > 0) {
    sections.push(`**Added Relationships (${addedEdges.length}):**\n${addedEdges.join("\n")}`);
  }
  if (deletedEdges.length > 0) {
    sections.push(`**Deleted Relationships (${deletedEdges.length}):**\n${deletedEdges.join("\n")}`);
  }

  if (sections.length === 0) {
    return "*(No changes)*";
  }

  return sections.join("\n\n");
}

import type { GraphSnapshot } from "@collabnode/graph";
import { walk } from "@collabnode/graph";

export interface SnapshotMarkdownOptions {
  /** Whether to output node properties below the title. Defaults to true. */
  includeProperties?: boolean;
  /** Filter to only include specific node types. */
  types?: string[];
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
}

function selectNodes(snapshot: GraphSnapshot, options: SnapshotMarkdownOptions): GraphSnapshot["nodes"] {
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
export function snapshotToMarkdown(
  snapshot: GraphSnapshot,
  options: SnapshotMarkdownOptions = {},
): string {
  const { includeProperties = true, maxNodes = 100, groupByType = true, includeEdges = true } = options;

  let nodes = selectNodes(snapshot, options);
  if (nodes.length > maxNodes) {
    nodes = nodes.slice(0, maxNodes);
  }
  const selectedIds = new Set(nodes.map((n) => n.id));
  const subgraph = options.ids !== undefined;
  const edges = includeEdges
    ? subgraph
      ? snapshot.edges.filter((e) => selectedIds.has(e.from) || selectedIds.has(e.to))
      : snapshot.edges
    : [];

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
        const title = n.properties.title || n.properties.name || n.id;
        lines.push(`- **${title}** (\`id: ${n.id}\`)`);
        if (includeProperties) {
          const props = Object.entries(n.properties).filter(([k]) => k !== "title" && k !== "name");
          if (props.length > 0) {
            for (const [k, v] of props) {
              if (v !== undefined && v !== null && v !== "") {
                const valStr = typeof v === "object" ? JSON.stringify(v) : String(v);
                lines.push(`  - *${k}*: ${valStr}`);
              }
            }
          }
        }
      }
      lines.push("");
    }
  } else {
    lines.push(`### Nodes (${nodes.length})`);
    for (const n of nodes) {
      const title = n.properties.title || n.properties.name || n.id;
      lines.push(`- [${n.type}] **${title}** (\`id: ${n.id}\`)`);
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
export function diffSnapshotsToMarkdown(
  previous: GraphSnapshot,
  next: GraphSnapshot,
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

import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from "@collabnode/graph";
import type { GraphSchema } from "@collabnode/schema";
import { accentBorder, edgeLabel, edgeTooltip, nodeColor, nodeLabel, nodeShape, nodeTooltip } from "./style.js";

export interface ViewFilters {
  hiddenNodeTypes: ReadonlySet<string>;
  hiddenEdgeTypes: ReadonlySet<string>;
  search: string;
  visibleNodeTypes?: ReadonlySet<string>;
}

export interface ViewNode {
  id: string;
  label: string;
  color: {
    background: string;
    border: string;
    highlight: { background: string; border: string };
    hover: { background: string; border: string };
  };
  shape: string;
  font: { color: string; face: string; size: number; strokeWidth: number };
  borderWidth: number;
  title: string;
  hidden: boolean;
  group: string;
  shadow: boolean;
  x?: number;
  y?: number;
}

export interface ViewEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  arrows: "" | "to";
  color: { color: string; highlight: string; hover: string };
  font: { color: string; size: number; strokeWidth: number; align: "horizontal" };
  width: number;
  hidden: boolean;
  title: string;
}

export interface GraphViewPlan {
  nodesAdd: ViewNode[];
  nodesUpdate: ViewNode[];
  nodesRemove: string[];
  edgesAdd: ViewEdge[];
  edgesUpdate: ViewEdge[];
  edgesRemove: string[];
}

const FONT = "IBM Plex Sans, Segoe UI, sans-serif";
const TEXT = "#e8edf7";
const MUTED = "#8b95ab";
const ACCENT = "#6ea8fe";

export function emptyFilters(): ViewFilters {
  return {
    hiddenNodeTypes: new Set(),
    hiddenEdgeTypes: new Set(),
    search: "",
    visibleNodeTypes: new Set(),
  };
}

/** Parse `visible-types="Epic,Feature"` — empty/absent means show all. */
export function parseVisibleTypes(value: string | null | undefined): Set<string> | undefined {
  if (value == null) {
    return undefined;
  }
  const types = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return types.length === 0 ? undefined : new Set(types);
}

export function nodeTypeHidden(filters: ViewFilters, type: string): boolean {
  if (filters.hiddenNodeTypes.has(type)) {
    return true;
  }
  const visible = filters.visibleNodeTypes;
  return Boolean(visible && visible.size > 0 && !visible.has(type));
}

function cloneVisibleTypes(types: ReadonlySet<string> | undefined): Set<string> | undefined {
  return types && types.size > 0 ? new Set(types) : undefined;
}

/** Merge a partial `filters` assignment. An explicit `visibleNodeTypes` is a layer: allow-listed types are un-hidden. */
export function patchFilters(current: ViewFilters, patch: Partial<ViewFilters>): ViewFilters {
  let hiddenNodeTypes =
    patch.hiddenNodeTypes !== undefined
      ? new Set(patch.hiddenNodeTypes)
      : new Set(current.hiddenNodeTypes);
  const hiddenEdgeTypes =
    patch.hiddenEdgeTypes !== undefined
      ? new Set(patch.hiddenEdgeTypes)
      : new Set(current.hiddenEdgeTypes);
  const search = patch.search !== undefined ? patch.search : current.search;

  let visibleNodeTypes = cloneVisibleTypes(current.visibleNodeTypes);
  if (patch.visibleNodeTypes !== undefined) {
    visibleNodeTypes = cloneVisibleTypes(patch.visibleNodeTypes);
    if (patch.hiddenNodeTypes === undefined && visibleNodeTypes) {
      for (const type of visibleNodeTypes) {
        hiddenNodeTypes.delete(type);
      }
    }
  }

  return { hiddenNodeTypes, hiddenEdgeTypes, search, visibleNodeTypes };
}

export function toggleNodeType(filters: ViewFilters, type: string): ViewFilters {
  const hiddenNodeTypes = new Set(filters.hiddenNodeTypes);
  const visibleNodeTypes = cloneVisibleTypes(filters.visibleNodeTypes);
  if (nodeTypeHidden(filters, type)) {
    hiddenNodeTypes.delete(type);
    if (visibleNodeTypes && !visibleNodeTypes.has(type)) {
      visibleNodeTypes.add(type);
    }
  } else {
    hiddenNodeTypes.add(type);
  }
  return {
    hiddenNodeTypes,
    hiddenEdgeTypes: new Set(filters.hiddenEdgeTypes),
    search: filters.search,
    visibleNodeTypes,
  };
}

export function projectGraph(
  schema: GraphSchema,
  snapshot: GraphSnapshot,
  filters: ViewFilters,
): { nodes: ViewNode[]; edges: ViewEdge[] } {
  const nodes = snapshot.nodes.map((node) => toViewNode(schema, node, filters, snapshot));
  const hiddenNodes = new Set(nodes.filter((node) => node.hidden).map((node) => node.id));
  const edges = snapshot.edges.map((edge) => toViewEdge(schema, edge, filters, hiddenNodes));
  return { nodes, edges };
}

export function planApply(
  existingNodeIds: ReadonlySet<string>,
  existingEdgeIds: ReadonlySet<string>,
  projected: { nodes: ViewNode[]; edges: ViewEdge[] },
): GraphViewPlan {
  const nextNodeIds = new Set(projected.nodes.map((node) => node.id));
  const nextEdgeIds = new Set(projected.edges.map((edge) => edge.id));
  return {
    nodesAdd: projected.nodes.filter((node) => !existingNodeIds.has(node.id)),
    nodesUpdate: projected.nodes.filter((node) => existingNodeIds.has(node.id)),
    nodesRemove: [...existingNodeIds].filter((id) => !nextNodeIds.has(id)),
    edgesAdd: projected.edges.filter((edge) => !existingEdgeIds.has(edge.id)),
    edgesUpdate: projected.edges.filter((edge) => existingEdgeIds.has(edge.id)),
    edgesRemove: [...existingEdgeIds].filter((id) => !nextEdgeIds.has(id)),
  };
}

export function changedEntityIds(previous: GraphSnapshot | undefined, next: GraphSnapshot): string[] {
  if (!previous) {
    return [];
  }
  const ids: string[] = [];
  const prevNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  for (const node of next.nodes) {
    const before = prevNodes.get(node.id);
    if (!before || recordChanged(before.properties, node.properties) || before.type !== node.type) {
      ids.push(node.id);
    }
  }
  const prevEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  for (const edge of next.edges) {
    const before = prevEdges.get(edge.id);
    if (
      !before ||
      recordChanged(before.properties, edge.properties) ||
      before.from !== edge.from ||
      before.to !== edge.to ||
      before.type !== edge.type
    ) {
      ids.push(edge.id);
    }
  }
  return ids;
}

export function newNodeIds(previous: GraphSnapshot | undefined, next: GraphSnapshot): string[] {
  if (!previous) {
    return [];
  }
  const prev = new Set(previous.nodes.map((node) => node.id));
  return next.nodes.filter((node) => !prev.has(node.id)).map((node) => node.id);
}

function recordChanged(
  before: GraphNodeRecord["properties"] | GraphEdgeRecord["properties"],
  after: GraphNodeRecord["properties"] | GraphEdgeRecord["properties"],
): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function toViewNode(
  schema: GraphSchema,
  node: GraphNodeRecord,
  filters: ViewFilters,
  snapshot: GraphSnapshot,
): ViewNode {
  const background = nodeColor(schema, node);
  const border = accentBorder(background);
  const hiddenByType = nodeTypeHidden(filters, node.type);
  const hiddenBySearch = !matchesSearch(schema, node, filters.search, snapshot);
  return {
    id: node.id,
    label: nodeLabel(schema, node),
    color: {
      background,
      border,
      highlight: { background, border: ACCENT },
      hover: { background, border: ACCENT },
    },
    shape: nodeShape(schema, node),
    font: { color: TEXT, face: FONT, size: 13, strokeWidth: 0 },
    borderWidth: 1,
    title: nodeTooltip(schema, node),
    hidden: hiddenByType || hiddenBySearch,
    group: node.type,
    shadow: true,
  };
}

function toViewEdge(
  schema: GraphSchema,
  edge: GraphEdgeRecord,
  filters: ViewFilters,
  hiddenNodes: ReadonlySet<string>,
): ViewEdge {
  const directed = schema.edges[edge.type]?.directed !== false;
  const hidden =
    filters.hiddenEdgeTypes.has(edge.type) || hiddenNodes.has(edge.from) || hiddenNodes.has(edge.to);
  const width = Object.keys(edge.properties).length > 0 ? 1.8 : 1.2;
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    label: edgeLabel(schema, edge),
    arrows: directed ? "to" : "",
    color: { color: "#3a445c", highlight: ACCENT, hover: ACCENT },
    font: { color: MUTED, size: 11, strokeWidth: 0, align: "horizontal" },
    width,
    hidden,
    title: edgeTooltip(schema, edge),
  };
}

function matchesSearch(
  schema: GraphSchema,
  node: GraphNodeRecord,
  search: string,
  snapshot: GraphSnapshot,
): boolean {
  const q = search.trim().toLowerCase();
  if (!q) {
    return true;
  }
  if (node.type.toLowerCase().includes(q) || nodeLabel(schema, node).toLowerCase().includes(q)) {
    return true;
  }
  if (node.id.toLowerCase().includes(q)) {
    return true;
  }
  for (const value of Object.values(node.properties)) {
    if (String(value).toLowerCase().includes(q)) {
      return true;
    }
  }
  if ((node.tags ?? []).some((tag) => tag.toLowerCase().includes(q))) {
    return true;
  }
  return snapshot.edges.some((edge) => {
    if (edge.from !== node.id && edge.to !== node.id) {
      return false;
    }
    return edge.type.toLowerCase().includes(q) || edgeLabel(schema, edge).toLowerCase().includes(q);
  });
}

export function withPulse(node: ViewNode): ViewNode {
  return {
    ...node,
    borderWidth: 4,
    color: {
      ...node.color,
      border: ACCENT,
      highlight: { background: node.color.background, border: ACCENT },
    },
  };
}

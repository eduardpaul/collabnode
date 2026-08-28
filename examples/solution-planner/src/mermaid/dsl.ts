import type { CollabSession } from "@collabnode/runtime";

type GraphSnapshot = ReturnType<CollabSession["snapshot"]>;
type GraphNodeRecord = GraphSnapshot["nodes"][number];
type GraphSchema = CollabSession["schema"];

const DEFAULT_HIDDEN = new Set(["SolutionState"]);
const C4_KINDS = new Set(["Person", "System", "Boundary", "Container", "Component"]);

function isC4Node(node: GraphNodeRecord): boolean {
  return node.type === "C4DiagramElement";
}

function c4Kind(node: GraphNodeRecord): string {
  return String(node.properties.type ?? "");
}
const DB_NAME = /db|database|redis|cosmos|sql|storage|queue|bus|cache|blob/i;

export interface SnapshotToMermaidOptions {
  visibleTypes?: ReadonlySet<string> | string | null;
  hiddenTypes?: ReadonlySet<string>;
  direction?: "TB" | "LR";
  kind?: "auto" | "c4" | "flowchart";
}

function parseVisibleTypes(value: string | null | undefined): Set<string> | undefined {
  if (value == null) return undefined;
  const types = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return types.length === 0 ? undefined : new Set(types);
}

function asVisibleSet(value: SnapshotToMermaidOptions["visibleTypes"]): Set<string> | undefined {
  if (value instanceof Set) {
    return value.size > 0 ? value : undefined;
  }
  return parseVisibleTypes(typeof value === "string" ? value : null);
}

function isHidden(
  type: string,
  visible: Set<string> | undefined,
  hidden: ReadonlySet<string>,
): boolean {
  if (visible && visible.size > 0) {
    return !visible.has(type);
  }
  return hidden.has(type);
}

function allocateIds(ids: string[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const id of ids) {
    const compact = id.replace(/[^a-zA-Z0-9]/g, "") || "x";
    let base = /^[A-Za-z]/.test(compact) ? compact : `n${compact}`;
    if (base.length > 24) base = base.slice(0, 24);
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${base}${n++}`;
    }
    used.add(candidate);
    map.set(id, candidate);
  }
  return map;
}

function escapeLabel(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/"/g, "'").replace(/[;{}]/g, " ").trim().slice(0, 80);
}

function quote(text: string): string {
  return `"${escapeLabel(text)}"`;
}

function isDatabaseTitle(title: string): boolean {
  return DB_NAME.test(title);
}

function labelOf(node: GraphNodeRecord): string {
  return String(node.properties.title ?? node.properties.name ?? node.type);
}

function descrOf(node: GraphNodeRecord): string {
  return String(node.properties.description ?? node.properties.markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function techOf(node: GraphNodeRecord): string {
  return String(node.properties.technology ?? "").trim();
}

function isExternal(node: GraphNodeRecord): boolean {
  return node.properties.external === true;
}

function typeColor(schema: GraphSchema | undefined, type: string): string {
  const color = schema?.nodes[type]?.ui?.color;
  if (typeof color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(color.trim())) {
    return color.trim();
  }
  return "#64748b";
}

function edgeCaption(type: string): string {
  return type.replaceAll("_", " ").toLowerCase();
}

function shapeLine(mid: string, label: string, node: GraphNodeRecord): string {
  const text = escapeLabel(label) || c4Kind(node) || node.type;
  const kind = c4Kind(node);
  if (kind === "Person") return `  ${mid}(["${text}"])`;
  if (kind === "System") return `  ${mid}["${text}"]`;
  if (kind === "Boundary") return `  ${mid}[["${text}"]]`;
  if (kind === "Container" && isDatabaseTitle(labelOf(node))) return `  ${mid}[("${text}")]`;
  if (kind === "Component") return `  ${mid}[["${text}"]]`;
  return `  ${mid}["${text}"]`;
}

function personCall(alias: string, node: GraphNodeRecord, indent: string): string {
  const fn = isExternal(node) ? "Person_Ext" : "Person";
  return `${indent}${fn}(${alias}, ${quote(labelOf(node))}, ${quote(descrOf(node) || labelOf(node))})`;
}

function systemCall(alias: string, node: GraphNodeRecord, indent: string): string {
  const fn = isExternal(node) ? "System_Ext" : "System";
  return `${indent}${fn}(${alias}, ${quote(labelOf(node))}, ${quote(descrOf(node) || labelOf(node))})`;
}

function containerCall(alias: string, node: GraphNodeRecord, indent: string): string {
  const ext = isExternal(node);
  const db = isDatabaseTitle(labelOf(node));
  const fn = db ? (ext ? "ContainerDb_Ext" : "ContainerDb") : ext ? "Container_Ext" : "Container";
  return `${indent}${fn}(${alias}, ${quote(labelOf(node))}, ${quote(techOf(node))}, ${quote(descrOf(node) || labelOf(node))})`;
}

function componentCall(alias: string, node: GraphNodeRecord, indent: string): string {
  return `${indent}Component(${alias}, ${quote(labelOf(node))}, ${quote(techOf(node))}, ${quote(descrOf(node) || labelOf(node))})`;
}

/**
 * Mermaid C4 syntax: https://mermaid.js.org/syntax/c4.html
 * C4DiagramElement.properties.type is Person, System, Boundary, Container, or Component.
 * Boundary → System_Boundary (grouping only). System → System / System_Ext (software).
 * external:true → Person_Ext / System_Ext / Container_Ext / ContainerDb_Ext.
 */
export function snapshotToC4Mermaid(snapshot: GraphSnapshot): string {
  const c4 = snapshot.nodes.filter((n) => isC4Node(n) && C4_KINDS.has(c4Kind(n)));
  const byId = new Map(c4.map((n) => [n.id, n]));
  const ids = allocateIds(c4.map((n) => n.id));
  const contains = snapshot.edges.filter(
    (e) => e.type === "CONTAINS" && byId.has(e.from) && byId.has(e.to),
  );
  const uses = snapshot.edges.filter(
    (e) => e.type === "USES" && byId.has(e.from) && byId.has(e.to),
  );
  const childIds = new Set(contains.map((e) => e.to));
  const childrenOf = (parentId: string) =>
    contains.filter((e) => e.from === parentId).map((e) => byId.get(e.to)!).filter(Boolean);

  const persons = c4.filter((n) => c4Kind(n) === "Person");
  const systems = c4.filter((n) => c4Kind(n) === "System");
  const boundaries = c4.filter((n) => c4Kind(n) === "Boundary");
  const containers = c4.filter((n) => c4Kind(n) === "Container");
  const components = c4.filter((n) => c4Kind(n) === "Component");

  const kind =
    containers.length > 0 || boundaries.length > 0
      ? "C4Container"
      : components.length > 0
        ? "C4Component"
        : "C4Context";

  const lines: string[] = [
    kind,
    `  title C4 ${kind === "C4Context" ? "Context" : kind === "C4Component" ? "Component" : "Container"} diagram`,
  ];

  if (c4.length === 0) {
    lines.push(`  System(empty, "No C4 elements yet", "Add Person, System, Boundary, Container, or Component")`);
    return lines.join("\n");
  }

  const emitted = new Set<string>();

  const emitNode = (node: GraphNodeRecord, indent: string) => {
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    const alias = ids.get(node.id)!;
    const kind = c4Kind(node);
    if (kind === "Person") {
      lines.push(personCall(alias, node, indent));
      return;
    }
    if (kind === "System") {
      lines.push(systemCall(alias, node, indent));
      return;
    }
    if (kind === "Container") {
      lines.push(containerCall(alias, node, indent));
      return;
    }
    if (kind === "Component") {
      lines.push(componentCall(alias, node, indent));
      return;
    }
    if (kind === "Boundary") {
      // Mermaid's C4 grammar has no empty-boundary production: a
      // `System_Boundary(...) { }` is a parse error that replaces the entire
      // diagram with an error box. A boundary with nothing inside it carries no
      // C4 meaning anyway, so it is left out until something CONTAINS-links to it.
      const children = childrenOf(node.id);
      if (children.length === 0) {
        return;
      }
      lines.push(`${indent}System_Boundary(${alias}, ${quote(labelOf(node))}) {`);
      for (const child of children) {
        emitNode(child, `${indent}  `);
      }
      lines.push(`${indent}}`);
    }
  };

  const topLevel = (n: GraphNodeRecord) => !childIds.has(n.id);

  if (kind === "C4Context") {
    for (const n of [...persons, ...systems].filter(topLevel)) emitNode(n, "  ");
  } else if (kind === "C4Component") {
    for (const n of [...persons, ...systems].filter(topLevel)) emitNode(n, "  ");
    for (const n of boundaries.filter(topLevel)) emitNode(n, "  ");
    for (const n of [...containers, ...components].filter(topLevel)) emitNode(n, "  ");
  } else {
    for (const n of [...persons, ...systems].filter(topLevel)) emitNode(n, "  ");
    for (const n of boundaries.filter(topLevel)) emitNode(n, "  ");
    for (const n of [...containers, ...components].filter(topLevel)) emitNode(n, "  ");
  }

  for (const n of c4) {
    if (!emitted.has(n.id)) emitNode(n, "  ");
  }

  for (const edge of uses) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from && to) {
      lines.push(`  Rel(${from}, ${to}, ${quote("Uses")})`);
    }
  }

  return lines.join("\n");
}

function snapshotToFlowchart(
  snapshot: GraphSnapshot,
  schema: GraphSchema | undefined,
  options: SnapshotToMermaidOptions,
): string {
  const visible = asVisibleSet(options.visibleTypes);
  const hidden = options.hiddenTypes ?? DEFAULT_HIDDEN;
  const direction = options.direction === "LR" ? "LR" : "TB";

  const nodes = snapshot.nodes.filter((n) => !isHidden(n.type, visible, hidden));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = snapshot.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  const ids = allocateIds(nodes.map((n) => n.id));

  if (nodes.length === 0) {
    return `flowchart ${direction}\n  empty["No nodes"]`;
  }

  const lines: string[] = [`flowchart ${direction}`];
  const groups = new Map<string, GraphNodeRecord[]>();
  for (const node of nodes) {
    const key = node.type;
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }
  const keys = [...groups.keys()].sort();
  const useSubgraphs = keys.length > 1;

  for (const key of keys) {
    const members = groups.get(key)!;
    members.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
    if (useSubgraphs) {
      const gid = /^[A-Za-z]/.test(key) ? key.replace(/[^a-zA-Z0-9]/g, "") : `g${key}`;
      lines.push(`  subgraph ${gid}["${escapeLabel(key)}"]`);
    }
    for (const node of members) {
      const mid = ids.get(node.id)!;
      lines.push((useSubgraphs ? "  " : "") + shapeLine(mid, labelOf(node), node));
    }
    if (useSubgraphs) {
      lines.push("  end");
    }
  }

  for (const edge of edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    lines.push(`  ${from} -->|${escapeLabel(edgeCaption(edge.type))}| ${to}`);
  }

  const types = [...new Set(nodes.map((n) => n.type))];
  for (const type of types) {
    const color = typeColor(schema, type);
    const safe = type.replace(/[^a-zA-Z0-9]/g, "") || "T";
    lines.push(`  classDef ${safe} fill:${color},stroke:${color},color:#fff`);
    const members = nodes.filter((n) => n.type === type).map((n) => ids.get(n.id)!);
    if (members.length > 0) {
      lines.push(`  class ${members.join(",")} ${safe}`);
    }
  }

  return lines.join("\n");
}

function shouldUseC4(snapshot: GraphSnapshot, options: SnapshotToMermaidOptions): boolean {
  if (options.kind === "c4") return true;
  if (options.kind === "flowchart") return false;
  const visible = asVisibleSet(options.visibleTypes);
  if (visible && visible.size === 1 && visible.has("C4DiagramElement")) return true;
  const hidden = options.hiddenTypes ?? DEFAULT_HIDDEN;
  const nodes = snapshot.nodes.filter((n) => !isHidden(n.type, visible, hidden));
  return nodes.length > 0 && nodes.every((n) => isC4Node(n));
}

export function snapshotToMermaid(
  snapshot: GraphSnapshot,
  schema: GraphSchema | undefined,
  options: SnapshotToMermaidOptions = {},
): string {
  if (shouldUseC4(snapshot, options)) {
    return snapshotToC4Mermaid(snapshot);
  }
  return snapshotToFlowchart(snapshot, schema, options);
}

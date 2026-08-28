import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from "@collabnode/graph";
import { walk } from "@collabnode/graph";
import type {
  GraphSchema,
  NodeAccessPolicy,
  ViewDef,
  ViewFormat,
} from "@collabnode/schema";
import {
  ALL_NODE_TYPES,
  evaluateExpression,
  resolveGuidelines,
  resolveI18nString,
  validateParams,
} from "@collabnode/schema";
import { snapshotToMarkdown } from "./snapshot-format.js";

/** Default cap on selected nodes, matching `snapshotToMarkdown`. */
const DEFAULT_MAX_NODES = 100;

export interface ResolveViewOptions {
  /** The view's name, used in error messages and in the rendered header. */
  name?: string;
  /** Language for `title`, `description` and `guidance`. */
  language?: string;
  /**
   * The calling role's reach. Node types hidden from the role are dropped from
   * the result. A view is a read like any other, and skipping this turns it
   * into a way around `nodes.hidden`.
   */
  access?: NodeAccessPolicy;
  /** Used for schema-aware node labels when rendering. */
  schema?: GraphSchema;
}

export interface ResolvedView {
  name?: string;
  title?: string;
  description?: string;
  guidance: string[];
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
  /** The per-type field projection the view declared, carried through for UIs. */
  fields?: Record<string, string[]>;
  /** True when `maxNodes` cut the selection short. */
  truncated?: boolean;
}

/**
 * The evaluation context for a `where` expression.
 *
 * Bare identifiers are node properties, so `dirty == true` and `priority ==
 * 'high'` read the way a person would write them; view parameters live under
 * `params.` so a parameter can share a name with a property without either
 * shadowing the other. `id` and `type` are always available.
 */
function whereContext(
  node: GraphNodeRecord,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return { ...node.properties, id: node.id, type: node.type, params };
}

/**
 * `where` is truthy-tested rather than required to be a boolean, so
 * `where: "mitigation"` means "has a mitigation" without ceremony. A parse error
 * cannot reach here — `validateWorkspaceType` parses every expression at load
 * time — but an evaluation error (dividing by zero, say) is treated as "does not
 * match" rather than failing the whole view.
 */
function matches(
  where: string | undefined,
  node: GraphNodeRecord,
  params: Record<string, unknown>,
  path: string,
): boolean {
  if (!where) {
    return true;
  }
  try {
    return Boolean(evaluateExpression(where, whereContext(node, params), path));
  } catch {
    return false;
  }
}

/**
 * Resolves one view against a snapshot: which nodes, which edges between them,
 * and the projection to print them with.
 *
 * Order matters. Roots are selected, traversal expands from them, `include`
 * types are unioned in, the role's hidden types are struck out, and only then is
 * `maxNodes` applied — so truncation cuts the tail of a complete selection
 * rather than starving the traversal of roots.
 */
export function resolveView(
  snapshot: GraphSnapshot,
  view: ViewDef,
  params: Record<string, unknown> = {},
  options: ResolveViewOptions = {},
): ResolvedView {
  const path = options.name ? `views.${options.name}` : "view";
  const resolvedParams = validateParams(view.params ?? {}, params, `${path}.params`);
  const access = options.access;
  const visible = (type: string) => !access?.isHidden(type);

  const select = view.select;
  const rootTypes = select?.roots?.types;
  const rootTypeSet = rootTypes && rootTypes.length > 0 ? new Set(rootTypes) : undefined;

  const selected = new Map<string, GraphNodeRecord>();

  const roots = snapshot.nodes.filter(
    (n) =>
      visible(n.type) &&
      (!rootTypeSet || rootTypeSet.has(n.type)) &&
      matches(select?.roots?.where, n, resolvedParams, `${path}.select.roots.where`),
  );
  for (const root of roots) {
    selected.set(root.id, root);
  }

  const traverse = select?.traverse;
  if (traverse) {
    for (const root of roots) {
      const result = walk(snapshot, root.id, {
        edgeTypes: traverse.edges,
        direction: traverse.direction ?? "out",
        depth: traverse.depth ?? 1,
      });
      for (const hop of result.hops) {
        if (!visible(hop.node.type)) {
          continue;
        }
        if (!matches(traverse.where, hop.node, resolvedParams, `${path}.select.traverse.where`)) {
          continue;
        }
        selected.set(hop.node.id, hop.node);
      }
    }
  }

  const includeTypes = select?.include;
  if (includeTypes && includeTypes.length > 0) {
    const includeSet = new Set(includeTypes);
    for (const node of snapshot.nodes) {
      if (includeSet.has(node.type) && visible(node.type)) {
        selected.set(node.id, node);
      }
    }
  }

  // Snapshot order, not insertion order: a view's output should not depend on
  // which root happened to reach a node first.
  const order = new Map(snapshot.nodes.map((n, i) => [n.id, i]));
  let nodes = [...selected.values()].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );

  const maxNodes = view.maxNodes ?? DEFAULT_MAX_NODES;
  const truncated = nodes.length > maxNodes;
  if (truncated) {
    nodes = nodes.slice(0, maxNodes);
  }

  // Both endpoints must survive, so the rendering never points at a node the
  // reader cannot see — whether it was cut by `maxNodes` or hidden by policy.
  const ids = new Set(nodes.map((n) => n.id));
  const edges =
    view.edges === false
      ? []
      : snapshot.edges.filter(
          (e) => ids.has(e.from) && ids.has(e.to) && !access?.isEdgeHidden(e.type),
        );

  return {
    name: options.name,
    title: resolveI18nString(view.title, options.language),
    description: resolveI18nString(view.description, options.language),
    guidance: resolveGuidelines(view.guidance, options.language),
    nodes,
    edges,
    fields: projectedFields(view, access),
    truncated: truncated || undefined,
  };
}

/**
 * The view's field projection with hidden types removed. Returned rather than
 * applied, because a UI wants the field list itself (to build columns) while the
 * markdown renderer wants it as a filter.
 */
function projectedFields(
  view: ViewDef,
  access: NodeAccessPolicy | undefined,
): Record<string, string[]> | undefined {
  if (!view.fields) {
    return undefined;
  }
  const out: Record<string, string[]> = {};
  for (const [type, fields] of Object.entries(view.fields)) {
    if (type === ALL_NODE_TYPES || !access?.isHidden(type)) {
      out[type] = fields;
    }
  }
  return out;
}

/**
 * Markdown for a resolved view: the view's own header, then its nodes and edges.
 *
 * The header carries description and guidance because the primary consumer is a
 * prompt, and a slice of a graph is far more useful when it arrives with what
 * the reader is supposed to do about it.
 */
export function renderViewMarkdown(
  snapshot: GraphSnapshot,
  resolved: ResolvedView,
  options: { schema?: GraphSchema } = {},
): string {
  const header: string[] = [];
  if (resolved.title) {
    header.push(`## ${resolved.title}`);
  }
  if (resolved.description) {
    header.push(resolved.description);
  }
  if (resolved.guidance.length > 0) {
    header.push(resolved.guidance.map((line) => `- ${line}`).join("\n"));
  }

  const body =
    resolved.nodes.length === 0
      ? "*(Nothing matches this view)*"
      : snapshotToMarkdown(snapshot, {
          ids: resolved.nodes.map((n) => n.id),
          // The view already decided which edges survive — both endpoints
          // selected. Handing them over explicitly stops the markdown renderer
          // from re-deriving a looser set and pointing at nodes it did not print.
          edgeIds: resolved.edges.map((e) => e.id),
          includeEdges: resolved.edges.length > 0,
          fields: resolved.fields,
          schema: options.schema,
          maxNodes: resolved.nodes.length,
        });

  const parts = [...header, body];
  if (resolved.truncated) {
    parts.push(`*(truncated to ${resolved.nodes.length} nodes)*`);
  }
  return parts.join("\n\n").trim();
}

export interface RenderViewOptions extends ResolveViewOptions {
  /** Overrides the view's declared `format`. */
  format?: ViewFormat;
}

/**
 * Resolves and renders a view in one call — markdown by default, since the
 * primary consumer is an agent prompt.
 */
export function renderView(
  snapshot: GraphSnapshot,
  view: ViewDef,
  params: Record<string, unknown> = {},
  options: RenderViewOptions = {},
): string | ResolvedView {
  const resolved = resolveView(snapshot, view, params, options);
  const format = options.format ?? view.format ?? "markdown";
  return format === "json"
    ? resolved
    : renderViewMarkdown(snapshot, resolved, { schema: options.schema });
}

import type {
  AgentDef,
  AgentNodePolicy,
  GraphSchema,
  ToolsPolicyDef,
} from "./types.js";

/** `*` in a node policy list means "every node type in the schema". */
export const ALL_NODE_TYPES = "*";

/**
 * One agent role's node-type reach, resolved against a concrete schema so
 * callers never have to re-expand `*` or re-apply the hidden-beats-read-only
 * precedence.
 */
export interface NodeAccessPolicy {
  /** Node types this role must not know about. */
  readonly hidden: ReadonlySet<string>;
  /** Node types this role reads but never writes. Disjoint from `hidden`. */
  readonly readOnly: ReadonlySet<string>;
  /**
   * Edge types no instance of which can ever be visible, because every type it
   * may run from — or every type it may run to — is hidden. Edges that merely
   * *may* touch a hidden node stay in the surface and are filtered per instance.
   */
  readonly hiddenEdges: ReadonlySet<string>;
  /**
   * Edge types no instance of which can be written, because every type they may
   * run from — or run to — is read-only or hidden. Attaching or detaching an
   * edge changes how its endpoints read to everyone, so it counts as touching
   * them; edge types with a writable endpoint still exist and are checked per
   * instance, once the endpoints resolve.
   */
  readonly readOnlyEdges: ReadonlySet<string>;
  /** Node types left visible, in schema order. */
  readonly visibleNodeTypes: readonly string[];
  /** Whether this policy restricts anything at all; false is the fast path. */
  readonly restricted: boolean;
  /** Whether any node type at all is writable; false means a passive observer. */
  readonly anyWritable: boolean;
  isHidden(nodeType: string): boolean;
  isEdgeHidden(edgeType: string): boolean;
  /** Whether an edge of this type could land on a hidden node. */
  edgeTouchesHidden(edgeType: string): boolean;
  /** Whether this role may create, update or delete nodes of this type. */
  canWrite(nodeType: string): boolean;
  /** Whether any instance of this edge type could be written. */
  canWriteEdge(edgeType: string): boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

function expand(
  list: string[] | undefined,
  schema: GraphSchema,
): Set<string> {
  const out = new Set<string>();
  for (const entry of list ?? []) {
    if (entry === ALL_NODE_TYPES) {
      for (const type of Object.keys(schema.nodes)) {
        out.add(type);
      }
      continue;
    }
    // Unknown names are dropped rather than thrown on: validateWorkspaceType
    // already rejects them at parse time, and a resolver that throws would turn
    // a stale name into a dead workspace instead of a stricter one.
    if (entry in schema.nodes) {
      out.add(entry);
    }
  }
  return out;
}

/** The policy that restricts nothing — what an unroled caller gets. */
export function openNodeAccess(schema: GraphSchema): NodeAccessPolicy {
  return {
    hidden: EMPTY,
    readOnly: EMPTY,
    hiddenEdges: EMPTY,
    readOnlyEdges: EMPTY,
    visibleNodeTypes: Object.keys(schema.nodes),
    restricted: false,
    anyWritable: true,
    isHidden: () => false,
    isEdgeHidden: () => false,
    edgeTouchesHidden: () => false,
    canWrite: () => true,
    canWriteEdge: () => true,
  };
}

/**
 * Resolves an agent's declared node policy against a schema.
 *
 * `agentRole` matches either the declared `role` or its `actorId`, the same
 * lookup the tool filter and the role prompt already use.
 */
export function resolveNodeAccess(
  schema: GraphSchema,
  tools: ToolsPolicyDef | undefined,
  agentRole: string | undefined,
): NodeAccessPolicy {
  const agent: AgentDef | undefined =
    agentRole && tools?.agents
      ? tools.agents.find((a) => a.role === agentRole || a.actorId === agentRole)
      : undefined;
  return nodeAccessFrom(schema, agent?.nodes);
}

/** Resolves a bare policy declaration, for callers that already have the agent. */
export function nodeAccessFrom(
  schema: GraphSchema,
  declared: AgentNodePolicy | undefined,
): NodeAccessPolicy {
  if (!declared || (!declared.hidden?.length && !declared.readOnly?.length)) {
    return openNodeAccess(schema);
  }

  const hidden = expand(declared.hidden, schema);
  const readOnly = expand(declared.readOnly, schema);
  for (const type of hidden) {
    readOnly.delete(type);
  }

  const writable = (nodeType: string) => !hidden.has(nodeType) && !readOnly.has(nodeType);
  const hiddenEdges = new Set<string>();
  const readOnlyEdges = new Set<string>();
  const touchesHidden = new Set<string>();
  const allOf = (ends: string[], count: number) => ends.length > 0 && count === ends.length;
  for (const [type, def] of Object.entries(schema.edges)) {
    const fromHidden = def.from.filter((t) => hidden.has(t)).length;
    const toHidden = def.to.filter((t) => hidden.has(t)).length;
    if (fromHidden > 0 || toHidden > 0) {
      touchesHidden.add(type);
    }
    if (allOf(def.from, fromHidden) || allOf(def.to, toHidden)) {
      hiddenEdges.add(type);
    }
    const fromUnwritable = def.from.filter((t) => !writable(t)).length;
    const toUnwritable = def.to.filter((t) => !writable(t)).length;
    if (allOf(def.from, fromUnwritable) || allOf(def.to, toUnwritable)) {
      readOnlyEdges.add(type);
    }
  }

  const visibleNodeTypes = Object.keys(schema.nodes).filter((type) => !hidden.has(type));

  return {
    hidden,
    readOnly,
    hiddenEdges,
    readOnlyEdges,
    visibleNodeTypes,
    restricted: hidden.size > 0 || readOnly.size > 0,
    anyWritable: Object.keys(schema.nodes).some(writable),
    isHidden: (nodeType) => hidden.has(nodeType),
    isEdgeHidden: (edgeType) => hiddenEdges.has(edgeType),
    edgeTouchesHidden: (edgeType) => touchesHidden.has(edgeType),
    canWrite: writable,
    canWriteEdge: (edgeType) => !readOnlyEdges.has(edgeType) && !hiddenEdges.has(edgeType),
  };
}

/**
 * The schema as this role is allowed to see it: hidden node types and the edge
 * types that can only ever reach them are struck out, and every surviving edge
 * type forgets that it could have run to a hidden endpoint.
 *
 * `schemaHash` is deliberately carried over unchanged. It identifies the
 * workspace contract peers negotiate on, not one participant's view of it, and
 * a per-agent hash would break that handshake for no gain.
 */
export function redactSchema(schema: GraphSchema, policy: NodeAccessPolicy): GraphSchema {
  if (policy.hidden.size === 0) {
    return schema;
  }
  const nodes: GraphSchema["nodes"] = {};
  for (const [type, def] of Object.entries(schema.nodes)) {
    if (!policy.isHidden(type)) {
      nodes[type] = def;
    }
  }
  const edges: GraphSchema["edges"] = {};
  for (const [type, def] of Object.entries(schema.edges)) {
    if (policy.isEdgeHidden(type)) {
      continue;
    }
    edges[type] = {
      ...def,
      from: def.from.filter((t) => !policy.isHidden(t)),
      to: def.to.filter((t) => !policy.isHidden(t)),
    };
  }
  return { ...schema, nodes, edges };
}

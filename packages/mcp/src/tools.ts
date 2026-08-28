import { McpServer } from "@modelcontextprotocol/server";
import type { GraphSnapshot } from "@collabnode/graph";
import {
  clampLimit,
  compactSnapshot,
  deleteGraphEdge,
  deleteGraphNode,
  graphActors,
  graphChanges,
  graphDescribe,
  graphGet,
  graphHistory,
  graphList,
  graphNeighbors,
  graphQuery,
  graphSearch,
  graphSimilar,
  graphSnapshot,
  resolveNodeRef,
  upsertGraphEdge,
  renderView,
  upsertGraphNode,
  type CollabSession,
  type GraphNodeRef,
  type GraphOpInput,
  type GraphSearchModes,
  type NodeRef,
} from "@collabnode/runtime";
import {
  ADVANCED_TOOLS,
  redactSchema,
  resolveGuidelines,
  resolveI18nString,
  resolveNodeAccess,
  toolListAllowsAll,
  type GraphSchema,
  type NamedToolDef,
  type NodeAccessPolicy,
  type AdvancedTool,
  type NodeTypeDef,
  type ToolsPolicyDef,
  type ViewDef,
} from "@collabnode/schema";

import { z, type ZodType } from "zod/v4";
import {
  formatGuidelinesBlurb,
  formatQueryToolDescription,
  formatSearchToolDescription,
  formatSimilarToolDescription,
  getLocale,
  type SupportedLanguage,
} from "./i18n.js";
import { toolName } from "./names.js";
import { paramsZod, propertiesZod, propertyZod } from "./property-zod.js";
import {
  emptyList,
  filterChanges,
  filterDescribe,
  filterGet,
  filterHistory,
  filterNeighbors,
  filterSearch,
  filterSnapshot,
  narrowTypes,
  noNodeMatchesError,
  nodeTypeOf,
  resolveVisible,
} from "./visibility.js";

export { compactSnapshot };

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(value: unknown, isError = false): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

function guidelinesBlurb(
  guidelines: string[] | undefined,
  language?: SupportedLanguage | string,
): string {
  return formatGuidelinesBlurb(guidelines, language);
}

/**
 * What `graph_search` can actually do here, in the model's words.
 */
export function searchToolDescription(
  modes: GraphSearchModes,
  language?: SupportedLanguage | string,
): string {
  return formatSearchToolDescription(modes, language);
}

export const SIMILAR_TOOL_DESCRIPTION =
  "Nodes that read like a given node, ranked by meaning. Takes a node id, not a search string, so use it for 'more like this', 'related notes', or finding near-duplicates before creating something new. Returns nothing about the node itself.";

export function similarToolDescription(language?: SupportedLanguage | string): string {
  return formatSimilarToolDescription(language);
}

export function queryToolDescription(
  graphKind: string,
  schema?: GraphSchema,
  language?: SupportedLanguage | string,
): string {
  return formatQueryToolDescription(graphKind, schema, language);
}

export interface BoundTool {
  name: string;
  description: string;
  inputSchema: ZodType;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const readOnly = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

const idempotentWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const destructiveWrite = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function createNodeRefZod(language?: SupportedLanguage | string): ZodType {
  const t = getLocale(language);
  return z.union([
    z.string().describe(t.tools.nodeRef.idOrPrefix),
    z.looseObject({}).describe(t.tools.nodeRef.identityObject),
  ]);
}

/**
 * The batch entries `session.applyBatch` accepts, as a schema rather than as
 * prose. A discriminated union is what lets the policy check below switch on
 * `op` and know the rest of the entry is the shape that goes with it — and it
 * is checked on both paths into a tool, since `toAgentTools` hands arguments
 * straight to the handler with no transport to validate them first.
 *
 * Endpoints are an id or `{ ref }` pointing at an earlier entry in the same
 * batch; the identity-object form the single-write tools accept is not part of
 * the batch API.
 */
function batchOpsZod(language?: SupportedLanguage | string): ZodType {
  const t = getLocale(language);
  const properties = z.looseObject({}).optional();
  const endpoint = z.union([
    z.string().describe(t.tools.nodeRef.idOrPrefix),
    z.object({ ref: z.string() }),
  ]);
  return z.array(
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("upsertNode"),
        type: z.string(),
        ref: z.string().optional(),
        id: z.string().optional(),
        properties,
        tags: z.array(z.string()).optional(),
      }),
      z.object({
        op: z.literal("upsertEdge"),
        type: z.string(),
        id: z.string().optional(),
        from: endpoint,
        to: endpoint,
        properties,
      }),
      z.object({ op: z.literal("deleteNode"), id: z.string() }),
      z.object({ op: z.literal("deleteEdge"), id: z.string() }),
    ]),
  );
}

/**
 * Enough of a `GraphSnapshot` for a diff to mean something. `schemaId` and
 * `schemaHash` are optional because a caller hands back what it was given, and
 * a diff is over nodes and edges either way.
 */
const propertyMapZod = z.looseObject({});
const metaZod = z.looseObject({});
const snapshotZod = z.object({
  schemaId: z.string().optional(),
  schemaHash: z.string().optional(),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      properties: propertyMapZod,
      tags: z.array(z.string()).optional(),
      meta: metaZod.optional(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      from: z.string(),
      to: z.string(),
      properties: propertyMapZod,
      meta: metaZod.optional(),
    }),
  ),
});

function parseSnapshot(value: unknown): GraphSnapshot {
  const parsed = snapshotZod.parse(value);
  return {
    schemaId: parsed.schemaId ?? "",
    schemaHash: parsed.schemaHash ?? "",
    nodes: parsed.nodes.map((node) => ({ ...node, meta: node.meta ?? {} })),
    edges: parsed.edges.map((edge) => ({ ...edge, meta: edge.meta ?? {} })),
  } as GraphSnapshot;
}

/** What an upsert tool says it does — one node, or the only node. */
function upsertNodeDescription(
  type: string,
  def: NodeTypeDef,
  language?: SupportedLanguage | string,
): string {
  const t = getLocale(language);
  const description = resolveI18nString(def.description, language) ?? "";
  const blurb = formatGuidelinesBlurb(resolveGuidelines(def.guidelines, language), language);
  return def.singleton
    ? t.tools.upsertSingletonNode(type, description, blurb)
    : t.tools.upsertNode(type, description, blurb);
}

function nodeUpsertInputSchema(
  def: NodeTypeDef,
  tagsEnabled: boolean,
  language?: SupportedLanguage | string,
): ZodType {
  const t = getLocale(language);
  const shape: Record<string, ZodType> = {};
  // A singleton has one node and the runtime knows which: an `id` argument
  // could only ever be right or wrong, so it is not offered.
  if (!def.singleton) {
    shape.id = z.string().optional().describe(t.tools.nodeUpsert.id);
  }
  if (tagsEnabled) {
    shape.tags = z.array(z.string()).optional().describe(t.tools.nodeUpsert.tags);
  }
  for (const [propName, prop] of Object.entries(def.properties)) {
    if (prop.derived !== undefined) {
      continue;
    }
    let field = propertyZod(prop, language);
    if (prop.required && prop.default === undefined) {
      field = field.optional();
    }
    shape[propName] = field;
  }
  return z.object(shape).superRefine((data, ctx) => {
    if (typeof data.id === "string") {
      return;
    }
    // Without an `id` argument there is nothing here that says whether this
    // write creates the singleton or updates it, and demanding every required
    // property would make partial updates impossible. The runtime still refuses
    // a create that is missing one — it knows whether the node is there.
    if (def.singleton) {
      return;
    }
    for (const [propName, prop] of Object.entries(def.properties)) {
      if (!prop.required || prop.default !== undefined) {
        continue;
      }
      const value = data[propName];
      if (value === undefined || value === null) {
        ctx.addIssue({
          code: "custom",
          message: t.tools.nodeUpsert.missingRequiredProperty(propName),
          path: [propName],
        });
      }
    }
  });
}

function safe(
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await handler(args ?? {});
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  };
}

function asNodeRef(value: unknown): GraphNodeRef {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return value as GraphNodeRef;
  }
  return String(value);
}

export interface BuildToolsOptions {
  graphKind?: string;
  policy?: ToolsPolicyDef;
  /**
   * Named graph slices from the workspace type's `views:` block. Each becomes a
   * read-only `view_<name>` tool, filtered by the role's `views` allowlist.
   */
  views?: Record<string, ViewDef>;
  agentRole?: string;
  language?: SupportedLanguage | string;
  /**
   * Node-type reach for this caller. Defaults to the policy declared for
   * `agentRole`; pass one to reuse a policy already resolved elsewhere.
   */
  access?: NodeAccessPolicy;
}

export function buildTools(
  schema: GraphSchema,
  session: CollabSession,
  optionsOrGraphKind: string | BuildToolsOptions = "memory",
): BoundTool[] {
  const options: BuildToolsOptions =
    typeof optionsOrGraphKind === "string"
      ? { graphKind: optionsOrGraphKind }
      : optionsOrGraphKind;
  const graphKind = options.graphKind ?? "memory";
  const policy = options.policy;
  const lang = options.language;
  const t = getLocale(lang);

  // What this role may see and write. `view` is the schema with hidden types
  // struck out, and it — not `schema` — is what generates the tool surface, so
  // a hidden type never reaches the model even as a tool name.
  const access = options.access ?? resolveNodeAccess(schema, policy, options.agentRole);
  const view = redactSchema(schema, access);
  const concealing = access.hidden.size > 0;

  /** Resolves an id this role is allowed to act on, or reports it as unknown. */
  const visibleId = (id: string, kinds: Array<"node" | "edge"> = ["node", "edge"]): string =>
    concealing ? resolveVisible(session, access, id, kinds).id : id;

  /** Resolves an edge endpoint, refusing hidden nodes as if they did not exist. */
  const visibleRef = (ref: GraphNodeRef): GraphNodeRef => {
    if (!concealing) {
      return ref;
    }
    if (typeof ref === "string") {
      return resolveVisible(session, access, ref, ["node"]).id;
    }
    // Identity objects have to go through the runtime's own matcher, so the
    // hidden check lands after resolution — with the not-found wording the
    // runtime would have used, to keep a hidden node indistinguishable from one
    // that was never there.
    const id = resolveNodeRef(session, ref);
    const type = nodeTypeOf(session, id);
    if (type && access.isHidden(type)) {
      throw noNodeMatchesError(ref);
    }
    return id;
  };

  const refuseUnwritable = (nodeId: string): void => {
    const type = nodeTypeOf(session, nodeId);
    if (type && !access.canWrite(type)) {
      throw new Error(t.tools.policy.readOnlyNodeType(type));
    }
  };

  const requireWritableNode = (id: string): string => {
    const resolved = visibleId(id, ["node"]);
    refuseUnwritable(resolved);
    return resolved;
  };

  /**
   * Endpoints of an edge write. Attaching or detaching an edge changes how both
   * of its endpoints read to everyone else, so a read-only node cannot be one.
   */
  const requireWritableRef = (ref: GraphNodeRef): GraphNodeRef => {
    const resolved = visibleRef(ref);
    if (typeof resolved === "string") {
      refuseUnwritable(resolved);
      return resolved;
    }
    const id = resolveNodeRef(session, resolved);
    refuseUnwritable(id);
    return id;
  };

  const requireWritableEdge = (id: string): string => {
    const resolved = visibleId(id, ["edge"]);
    const edge = session.snapshot().edges.find((record) => record.id === resolved);
    if (edge) {
      refuseUnwritable(edge.from);
      refuseUnwritable(edge.to);
    }
    return resolved;
  };

  /**
   * A batch endpoint is either an id or `{ ref }` naming a node created earlier
   * in the same batch — whose type was already cleared when that entry was
   * checked. Ids go through the same endpoint rule as `upsert_edge_*`.
   */
  const requireWritableBatchRef = (ref: NodeRef): NodeRef => {
    if (typeof ref !== "string") {
      return ref;
    }
    const resolved = requireWritableRef(ref);
    // `requireWritableRef` returns an id for an id; the object form is only
    // reachable from the identity-object input the batch API does not accept.
    return typeof resolved === "string" ? resolved : ref;
  };

  /**
   * Put every entry of a batch through the check its single-write tool would
   * have applied, and return the ops with ids and endpoints resolved the way
   * that tool would have resolved them.
   *
   * Node upserts are checked by type rather than by id, exactly as
   * `upsert_node_*` is: the type is what the write lands as, a writable type is
   * never a hidden one, and an id belonging to some other type is refused by
   * the runtime's own type check. Resolving the id here instead would reject
   * creates that carry a caller-chosen id, since that id matches nothing yet.
   *
   * A `{ ref }` endpoint needs no check of its own: it can only name a node
   * created earlier in this same batch, whose type was already cleared above.
   */
  const authorizeBatchOps = (ops: GraphOpInput[]): GraphOpInput[] =>
    ops.map((op) => {
      if (op.op === "upsertNode") {
        if (!access.canWrite(op.type)) {
          throw new Error(t.tools.policy.readOnlyNodeType(op.type));
        }
        return op;
      }
      if (op.op === "upsertEdge") {
        if (!access.canWriteEdge(op.type)) {
          throw new Error(t.tools.policy.readOnlyEdgeType(op.type));
        }
        return {
          ...op,
          from: requireWritableBatchRef(op.from),
          to: requireWritableBatchRef(op.to),
        };
      }
      if (op.op === "deleteNode") {
        return { ...op, id: requireWritableNode(op.id) };
      }
      if (op.op === "deleteEdge") {
        return { ...op, id: requireWritableEdge(op.id) };
      }
      const unknown = op as { op?: unknown };
      throw new Error(t.tools.policy.unknownBatchOp(String(unknown.op)));
    });

  let tools: BoundTool[] = [];
  const modes = session.searchModes();
  const nodeRefZod = createNodeRefZod(lang);
  const batchOps = batchOpsZod(lang);

  const add = (
    name: string,
    description: string,
    inputSchema: ZodType,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    annotations: BoundTool["annotations"] = readOnly,
  ) => {
    tools.push({ name, description, inputSchema, annotations, handler: safe(handler) });
  };

  // `tools.advanced` is the only door to ADVANCED_TOOLS: each one either hands
  // the model the whole graph or takes it back as an argument, and the targeted
  // reads plus declared `views:` cover the same ground far more cheaply. A
  // workspace that genuinely wants Cypher or batched writes asks for them.
  const advanced = new Set<AdvancedTool>(policy?.advanced ?? []);
  const wants = (tool: AdvancedTool) => advanced.has(tool);

  add(
    "graph_describe",
    t.tools.describe,
    z.object({}),
    async () => {
      const described = graphDescribe(session);
      const filtered = access.restricted ? filterDescribe(described, access) : described;
      // The contract must advertise the tools this caller actually has. Reads
      // are a fixed list in the runtime, but `tools.advanced` and the expose /
      // agent filters all subtract from it, so intersect with what was built —
      // `tools` is read at call time, after every filter has run.
      const built = new Set(tools.map((tool) => tool.name));
      return textResult({
        ...filtered,
        reads: filtered.reads.filter((name) => built.has(name)),
      });
    },
  );

  add(
    "graph_list",
    t.tools.list.description,
    z.object({
      types: z.array(z.string()).optional().describe(t.tools.list.types),
      tag: z.string().optional().describe(t.tools.list.tag),
      q: z.string().optional().describe(t.tools.list.q),
      limit: z.number().optional().describe(t.tools.list.limit),
      offset: z.number().optional().describe(t.tools.list.offset),
    }),
    async (args) => {
      const { types, empty } = narrowTypes(
        Array.isArray(args.types) ? (args.types as string[]) : undefined,
        access,
      );
      const offset = typeof args.offset === "number" ? Math.max(0, Math.floor(args.offset)) : 0;
      if (empty) {
        return textResult(
          emptyList(offset, clampLimit(typeof args.limit === "number" ? args.limit : undefined)),
        );
      }
      return textResult(
        graphList(session, {
          types,
          tag: typeof args.tag === "string" ? args.tag : undefined,
          q: typeof args.q === "string" ? args.q : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          offset: typeof args.offset === "number" ? args.offset : undefined,
        }),
      );
    },
  );

  add(
    "graph_get",
    t.tools.get.description,
    z.object({
      id: z.string().describe(t.tools.get.id),
    }),
    async (args) => {
      const result = graphGet(session, { id: visibleId(String(args.id)) });
      return textResult(concealing ? filterGet(result, session, access) : result);
    },
  );

  add(
    "graph_search",
    searchToolDescription(modes, lang),
    z.object({
      q: z
        .string()
        .optional()
        .describe(modes.vector ? t.tools.search.qVector : t.tools.search.qText),
      types: z.array(z.string()).optional().describe(t.tools.search.types),
      tag: z.string().optional().describe(t.tools.search.tag),
      limit: z.number().optional().describe(t.tools.search.limit),
    }),
    async (args) => {
      const { types, empty } = narrowTypes(
        Array.isArray(args.types) ? (args.types as string[]) : undefined,
        access,
      );
      if (empty) {
        return textResult({ nodes: [], total: 0 });
      }
      const result = await graphSearch(session, {
        q: typeof args.q === "string" ? args.q : undefined,
        types,
        tag: typeof args.tag === "string" ? args.tag : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return textResult(concealing ? filterSearch(result, access) : result);
    },
  );

  if (modes.vector) {
    add(
      "graph_similar",
      similarToolDescription(lang),
      z.object({
        id: z.string().describe(t.tools.similar.id),
        types: z.array(z.string()).optional().describe(t.tools.similar.types),
        limit: z.number().optional().describe(t.tools.similar.limit),
      }),
      async (args) => {
        const { types, empty } = narrowTypes(
          Array.isArray(args.types) ? (args.types as string[]) : undefined,
          access,
        );
        if (empty) {
          return textResult({ nodes: [], total: 0 });
        }
        const result = await graphSimilar(session, {
          id: visibleId(String(args.id), ["node"]),
          types,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        return textResult(concealing ? filterSearch(result, access) : result);
      },
    );
  }

  add(
    "graph_neighbors",
    t.tools.neighbors.description,
    z.object({
      id: z.string(),
      edgeTypes: z.array(z.string()).optional(),
      direction: z.enum(["in", "out", "both"]).optional(),
      depth: z.number().optional().describe(t.tools.neighbors.depth),
      limit: z.number().optional().describe(t.tools.neighbors.limit),
    }),
    async (args) => {
      const result = graphNeighbors(session, {
        id: visibleId(String(args.id), ["node"]),
        edgeTypes: Array.isArray(args.edgeTypes) ? (args.edgeTypes as string[]) : undefined,
        direction: args.direction === "in" || args.direction === "out" ? args.direction : undefined,
        depth: typeof args.depth === "number" ? args.depth : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return textResult(concealing ? filterNeighbors(result, session, access) : result);
    },
  );

  if (wants("graph_snapshot")) {
    add(
      "graph_snapshot",
      t.tools.snapshot.description,
      z.object({
        types: z.array(z.string()).optional().describe(t.tools.snapshot.types),
        includeText: z.boolean().optional().describe(t.tools.snapshot.includeText),
      }),
      async (args) => {
        const { types, empty } = narrowTypes(
          Array.isArray(args.types) ? (args.types as string[]) : undefined,
          access,
        );
        const snapshot = session.snapshot();
        if (empty) {
          return textResult({
            schemaId: snapshot.schemaId,
            schemaHash: snapshot.schemaHash,
            nodes: [],
            edges: [],
          });
        }
        const result = graphSnapshot(session, { types, includeText: args.includeText === true });
        return textResult(concealing ? filterSnapshot(result, session, access) : result);
      },
    );
  }

  // Cypher runs against the projection, which knows nothing of this role's
  // policy and cannot be filtered after the fact once a query aggregates. A role
  // with hidden node types therefore gets no `graph_query` at all — the tools
  // above answer the same questions within its view.
  if (wants("graph_query") && !concealing) {
    add(
      "graph_query",
      queryToolDescription(graphKind, view, lang),
      z.object({
        cypher: z.string().describe(t.tools.query.cypher),
        params: z.record(z.string(), z.unknown()).optional().describe(t.tools.query.params),
        limit: z.number().optional().describe(t.tools.query.limit),
      }),
      async (args) =>
        textResult(
          await graphQuery(
            session,
            {
              cypher: String(args.cypher),
              params:
                args.params && typeof args.params === "object"
                  ? (args.params as Record<string, unknown>)
                  : undefined,
              limit: typeof args.limit === "number" ? args.limit : undefined,
            },
            { graphKind },
          ),
        ),
    );
  }

  add(
    "graph_history",
    t.tools.history.description,
    z.object({
      id: z.string().optional(),
      actorId: z.string().optional(),
      since: z.string().optional(),
      limit: z.number().optional().describe(t.tools.history.limit),
    }),
    async (args) => {
      const result = graphHistory(session, {
        id: typeof args.id === "string" ? visibleId(args.id) : undefined,
        actorId: typeof args.actorId === "string" ? args.actorId : undefined,
        since: typeof args.since === "string" ? args.since : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return textResult(concealing ? filterHistory(result, session, access) : result);
    },
  );

  add(
    "graph_changes",
    t.tools.changes.description,
    z.object({
      since: z.string().optional().describe(t.tools.changes.since),
      actorId: z.string().optional(),
      limit: z.number().optional().describe(t.tools.changes.limit),
    }),
    async (args) => {
      const result = graphChanges(session, {
        since: typeof args.since === "string" ? args.since : undefined,
        actorId: typeof args.actorId === "string" ? args.actorId : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return textResult(concealing ? filterChanges(result, session, access) : result);
    },
  );

  add(
    "graph_actors",
    t.tools.actors,
    z.object({}),
    async () => textResult(graphActors(session)),
  );

  // A role that may write nothing gets no delete tools at all, rather than two
  // that always refuse.
  if (access.anyWritable) {
    add(
      "graph_delete_node",
      t.tools.deleteNode,
      z.object({ id: z.string() }),
      async (args) =>
        textResult(await deleteGraphNode(session, { id: requireWritableNode(String(args.id)) })),
      destructiveWrite,
    );

    add(
      "graph_delete_edge",
      t.tools.deleteEdge,
      z.object({ id: z.string() }),
      async (args) =>
        textResult(await deleteGraphEdge(session, { id: requireWritableEdge(String(args.id)) })),
      destructiveWrite,
    );

    // One batch, the same write rules as the tools it stands in for. Without
    // `authorizeBatchOps` this tool is a hole straight through the policy: it
    // is reachable as soon as *any* type is writable, and `applyOps` knows
    // nothing about roles, so a role allowed to write one node type could
    // rewrite and delete every other one through here.
    if (wants("graph_apply_batch")) {
      add(
        "graph_apply_batch",
        t.tools.applyBatch.description,
        z.object({ ops: batchOps.describe(t.tools.applyBatch.ops) }),
        async (args) =>
          textResult(
            await session.applyBatch(
              authorizeBatchOps(batchOps.parse(args.ops) as GraphOpInput[]),
            ),
          ),
        idempotentWrite,
      );
    }
  }

  // Withheld from a concealing role for the reason `graph_query` is: a diff
  // aggregates the whole graph into one answer, and there is no filtering it
  // afterwards — the hidden types would be named in `ops` and spelled out in
  // the Markdown. The role's own reads already show it everything it may see.
  if (wants("graph_diff_since") && !concealing) {
    add(
      "graph_diff_since",
      t.tools.diffSince.description,
      z.object({
        previousSnapshot: snapshotZod.describe(t.tools.diffSince.previousSnapshot),
      }),
      async (args) => textResult(session.diffSince(parseSnapshot(args.previousSnapshot))),
      readOnly,
    );
  }

  for (const [type, def] of Object.entries(view.nodes)) {
    if (!access.canWrite(type)) {
      continue;
    }
    const desc = upsertNodeDescription(type, def, lang);

    add(
      toolName("upsert_node", type),
      desc,
      nodeUpsertInputSchema(def, schema.config.tags?.enabled === true, lang),
      async (args) => {
        const { id, tags, ...rest } = args;
        const properties: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(rest)) {
          if (name === "tags") {
            continue;
          }
          if (value !== undefined) {
            properties[name] = value;
          }
        }
        return textResult(
          await upsertGraphNode(session, {
            type,
            id: typeof id === "string" ? id : undefined,
            properties,
            tags: Array.isArray(tags) ? (tags as string[]) : undefined,
          }),
        );
      },
      idempotentWrite,
    );
  }

  for (const [type, def] of Object.entries(view.edges)) {
    if (!access.canWriteEdge(type)) {
      continue;
    }
    const edgeDesc = resolveI18nString(def.description, lang);
    const edgeGuidelines = resolveGuidelines(def.guidelines, lang);
    const desc = t.tools.upsertEdge(
      type,
      def.from.join("|"),
      def.to.join("|"),
      edgeDesc ?? "",
      guidelinesBlurb(edgeGuidelines, lang),
    );

    add(
      toolName("upsert_edge", type),
      desc,
      propertiesZod(def.properties, lang).extend({
        id: z.string().optional(),
        from: nodeRefZod.describe(t.tools.edgeUpsert.from(def.from.join(" | "))),
        to: nodeRefZod.describe(t.tools.edgeUpsert.to(def.to.join(" | "))),
      }),
      async (args) => {
        const { id, from, to, ...properties } = args;
        return textResult(
          await upsertGraphEdge(session, {
            type,
            id: typeof id === "string" ? id : undefined,
            from: requireWritableRef(asNodeRef(from)),
            to: requireWritableRef(asNodeRef(to)),
            properties,
          }),
        );
      },
      idempotentWrite,
    );
  }

  // Filter generated tools if policy.expose is a specific allowlist.
  // `*` (or an omitted/empty list) keeps every generated tool.
  if (policy?.expose && !toolListAllowsAll(policy.expose)) {
    const exposeSet = new Set(policy.expose);
    tools = tools.filter((tool) => exposeSet.has(tool.name));
  }

  // Register named tools from policy.named
  if (policy?.named) {
    for (const [name, def] of Object.entries(policy.named)) {
      // A named tool is a shorthand for a write, so it inherits the write rules
      // of what it writes: no tool for a type this role may not create, and none
      // for an edge it may not see.
      if (def.creates && !access.canWrite(def.creates)) {
        continue;
      }
      if (def.into && !access.canWriteEdge(def.into)) {
        continue;
      }
      const namedTool = buildNamedTool(name, def, view, session, lang);
      if (namedTool) {
        tools.push(namedTool);
      }
    }
  }

  // One read-only tool per view the role is granted.
  //
  // Views are appended after `tools.expose` for the same reason named tools are:
  // they are declared by name in the document, not generated, so an `expose`
  // allowlist that predates them should not silently drop them. They are still
  // subject to `agents[].tools` below, and to `agents[].views` here.
  if (options.views) {
    const agent =
      options.agentRole && policy?.agents
        ? policy.agents.find(
            (a) => a.role === options.agentRole || a.actorId === options.agentRole,
          )
        : undefined;
    const grantsAll = toolListAllowsAll(agent?.views);
    const granted = grantsAll ? undefined : new Set(agent?.views);

    for (const [viewName, viewDef] of Object.entries(options.views)) {
      if (granted && !granted.has(viewName)) {
        continue;
      }
      // A view whose roots are all hidden from this role can only ever answer
      // "nothing", and offering a tool that always answers nothing tells the
      // model a type exists. Withhold it, the way `graph_query` is withheld.
      const rootTypes = viewDef.select?.roots?.types;
      if (rootTypes && rootTypes.length > 0 && rootTypes.every((type) => access.isHidden(type))) {
        continue;
      }

      const viewDesc = resolveI18nString(viewDef.description, lang) ?? "";
      const guidance = resolveGuidelines(viewDef.guidance, lang);
      add(
        toolName("view", viewName),
        t.tools.view.description(
          viewName,
          viewDesc,
          guidance.length > 0 ? t.tools.view.guidanceBlurb(guidance.join("; ")) : "",
        ),
        paramsZod(viewDef.params ?? {}, lang),
        async (args) =>
          textResult(
            renderView(session.snapshot(), viewDef, args, {
              name: viewName,
              language: lang,
              access,
              schema,
            }),
          ),
        readOnly,
      );
    }
  }

  // Agent role tool filtering
  if (options.agentRole && policy?.agents) {
    const agent = policy.agents.find(
      (a) => a.role === options.agentRole || a.actorId === options.agentRole,
    );
    if (agent && !toolListAllowsAll(agent.tools)) {
      const allowed = new Set(agent.tools);
      tools = tools.filter((tool) => allowed.has(tool.name));
    }
  }

  return tools;
}

function buildNamedTool(
  name: string,
  def: NamedToolDef,
  schema: GraphSchema,
  session: CollabSession,
  language?: SupportedLanguage | string,
): BoundTool | undefined {
  const t = getLocale(language);
  const createsType = def.creates;
  const nodeDef = createsType ? schema.nodes[createsType] : undefined;
  const intoType = def.into;
  const edgeDef = intoType ? schema.edges[intoType] : undefined;

  const shape: Record<string, ZodType> = {};
  const tagsEnabled = schema.config.tags?.enabled === true;

  // No `id` for a singleton: there is one node of that type and the runtime
  // knows which, so the argument could only ever be right or wrong.
  if (createsType && !nodeDef?.singleton) {
    shape.id = z.string().optional().describe(t.tools.namedToolInput.id(createsType));
  }
  if (createsType && tagsEnabled) {
    shape.tags = z.array(z.string()).optional().describe(t.tools.namedToolInput.tags);
  }

  const propsToUse = def.properties ?? (nodeDef ? nodeDef.properties : {});
  for (const [propName, prop] of Object.entries(propsToUse)) {
    if (prop.derived !== undefined) {
      continue;
    }
    let field = propertyZod(prop, language);
    if (prop.required && prop.default === undefined) {
      field = field.optional();
    }
    shape[propName] = field;
  }

  if (intoType) {
    const toTypes = edgeDef ? edgeDef.to.join(" | ") : "node";
    const toDesc = t.tools.namedToolInput.intoParent(intoType, toTypes);
    shape.into = z.string().optional().describe(toDesc);
    shape.to = z.string().optional().describe(toDesc);
    if (edgeDef && edgeDef.to.length === 1) {
      const aliasField = edgeDef.to[0]!.toLowerCase();
      shape[aliasField] = z.string().optional().describe(toDesc);
    }
  }

  const inputSchema = z.object(shape).superRefine((data, ctx) => {
    if (typeof data.id === "string") {
      return;
    }
    for (const [propName, prop] of Object.entries(propsToUse)) {
      if (!prop.required || prop.default !== undefined) {
        continue;
      }
      const value = data[propName];
      if (value === undefined || value === null) {
        ctx.addIssue({
          code: "custom",
          message: t.tools.nodeUpsert.missingRequiredProperty(propName),
          path: [propName],
        });
      }
    }
  });

  const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const { id, tags, into, to, ...rest } = args;
    const properties: Record<string, unknown> = {};

    let targetEndpoint: string | undefined;
    if (typeof into === "string") {
      targetEndpoint = into;
    } else if (typeof to === "string") {
      targetEndpoint = to;
    }
    if (!targetEndpoint && edgeDef && edgeDef.to.length === 1) {
      const aliasField = edgeDef.to[0]!.toLowerCase();
      if (typeof args[aliasField] === "string") {
        targetEndpoint = args[aliasField] as string;
      }
    }

    for (const [k, v] of Object.entries(rest)) {
      if (edgeDef && edgeDef.to.length === 1 && k === edgeDef.to[0]!.toLowerCase()) {
        continue;
      }
      if (v !== undefined) {
        properties[k] = v;
      }
    }

    if (createsType) {
      const nodeResult = await upsertGraphNode(session, {
        type: createsType,
        id: typeof id === "string" ? id : undefined,
        properties,
        tags: Array.isArray(tags) ? (tags as string[]) : undefined,
      });

      if (intoType && targetEndpoint) {
        const edgeResult = await upsertGraphEdge(session, {
          type: intoType,
          from: nodeResult.id,
          to: asNodeRef(targetEndpoint),
        });
        return textResult({
          created: true,
          id: nodeResult.id,
          type: createsType,
          edgeId: edgeResult.id,
          into: intoType,
          target: targetEndpoint,
        });
      }

      return textResult({
        created: true,
        id: nodeResult.id,
        type: createsType,
      });
    }

    return textResult({ ok: true, args });
  };

  const namedDesc = resolveI18nString(def.description, language);
  return {
    name,
    description: namedDesc ?? t.tools.namedTool(name),
    inputSchema,
    annotations: idempotentWrite,
    handler: safe(handler),
  };
}

export function registerSessionTools(
  schema: GraphSchema,
  session: CollabSession,
  server: McpServer,
  optionsOrGraphKind: string | BuildToolsOptions = "memory",
): string[] {
  const tools = buildTools(schema, session, optionsOrGraphKind);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      tool.handler as never,
    );
  }
  return tools.map((tool) => tool.name);
}

export interface AgentTool<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  /** The same zod schema the MCP transport validates against. */
  inputSchema: ZodType;
  /** The tool's arguments as JSON Schema, for callers that cannot take zod. */
  jsonSchema: JsonSchemaTool["parameters"];
  execute: (args: TArgs) => Promise<TResult>;
}

/**
 * Converts BoundTool[] into an in-process agent tool map suitable for
 * LangChain, Vercel AI SDK, AutoGen, or custom agent loops.
 *
 * `execute` validates its arguments before running, because nothing else on
 * this path does: an MCP transport parses `inputSchema` for you, an in-process
 * agent loop calls straight through.
 */
export function toAgentTools(
  tools: BoundTool[],
  schema?: GraphSchema,
): Record<string, AgentTool> {
  const result: Record<string, AgentTool> = {};
  for (const tool of tools) {
    result[tool.name] = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      jsonSchema: toolJsonSchema(tool, schema),
      execute: async (args) => {
        const parsed = tool.inputSchema.parse(args ?? {}) as Record<string, unknown>;
        const res = await tool.handler(parsed);
        if (res.isError) {
          throw new Error(res.content.map((entry) => entry.text).join("\n"));
        }
        const text = res.content[0]?.text ?? "{}";
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      },
    };
  }
  return result;
}

/** A tool as the function-calling APIs want it: a name, prose, JSON Schema. */
export interface JsonSchemaTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * One tool's arguments as JSON Schema, for the function-calling APIs that take
 * no zod: the realtime voice models, the chat-completions `tools` array,
 * anything speaking the OpenAI function shape.
 *
 * Pass `schema` to get `required` right. `buildTools` makes every upsert
 * property optional, because an upsert is also a partial update — but a model
 * reads optional-everything as permission to send a Note with a title and no
 * body, announce that it wrote the note, and move on. Prose guidelines lose to
 * the machine-readable contract, so the schema's own `required: true` flags are
 * mirrored here. Bodies are replaced wholesale on write, so "send the whole
 * thing" is the right contract for updates too.
 */
export function toolJsonSchema(
  tool: BoundTool,
  schema?: GraphSchema,
): JsonSchemaTool["parameters"] {
  const converted = z.toJSONSchema(tool.inputSchema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  // `$schema` is noise to every consumer of this, and the realtime APIs reject
  // the extra key outright.
  const { $schema: _ignored, ...rest } = converted;
  const parameters = {
    type: "object" as const,
    properties: {},
    ...rest,
  } as JsonSchemaTool["parameters"];
  const required = schema ? requiredNodeProperties(tool.name, schema, parameters.properties) : [];
  return required.length > 0 ? { ...parameters, required } : parameters;
}

/** Every tool in the list, in the shape the function-calling APIs expect. */
export function toJsonSchemaTools(
  tools: BoundTool[],
  schema?: GraphSchema,
): JsonSchemaTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toolJsonSchema(tool, schema),
  }));
}

/** The `required: true` properties of the node type an upsert tool writes. */
function requiredNodeProperties(
  name: string,
  schema: GraphSchema,
  properties: Record<string, unknown>,
): string[] {
  const type = Object.keys(schema.nodes).find(
    (nodeType) => toolName("upsert_node", nodeType) === name,
  );
  const def = type ? schema.nodes[type] : undefined;
  // A singleton's tool is nearly always updating the node rather than making
  // it, and its arguments carry no id to tell the two apart, so marking every
  // required property required would forbid touching one field.
  if (!def || def.singleton) {
    return [];
  }
  return Object.entries(def.properties)
    .filter(([propName, prop]) => prop.required === true && propName in properties)
    .map(([propName]) => propName);
}

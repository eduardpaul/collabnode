import { McpServer } from "@modelcontextprotocol/server";
import {
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
  upsertGraphEdge,
  upsertGraphNode,
  type CollabSession,
  type GraphNodeRef,
  type GraphSearchModes,
} from "@collabnode/runtime";
import {
  resolveGuidelines,
  resolveI18nString,
  type GraphSchema,
  type NamedToolDef,
  type NodeTypeDef,
  type ToolsPolicyDef,
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
import { propertiesZod, propertyZod } from "./property-zod.js";

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
    z.record(z.string(), z.unknown()).describe(t.tools.nodeRef.identityObject),
  ]);
}

function nodeUpsertInputSchema(
  def: NodeTypeDef,
  tagsEnabled: boolean,
  language?: SupportedLanguage | string,
): ZodType {
  const t = getLocale(language);
  const shape: Record<string, ZodType> = {
    id: z.string().optional().describe(t.tools.nodeUpsert.id),
  };
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
  agentRole?: string;
  language?: SupportedLanguage | string;
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

  let tools: BoundTool[] = [];
  const modes = session.searchModes();
  const nodeRefZod = createNodeRefZod(lang);

  const add = (
    name: string,
    description: string,
    inputSchema: ZodType,
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    annotations: BoundTool["annotations"] = readOnly,
  ) => {
    tools.push({ name, description, inputSchema, annotations, handler: safe(handler) });
  };

  add(
    "graph_describe",
    t.tools.describe,
    z.object({}),
    async () => textResult(graphDescribe(session)),
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
    async (args) =>
      textResult(
        graphList(session, {
          types: Array.isArray(args.types) ? (args.types as string[]) : undefined,
          tag: typeof args.tag === "string" ? args.tag : undefined,
          q: typeof args.q === "string" ? args.q : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          offset: typeof args.offset === "number" ? args.offset : undefined,
        }),
      ),
  );

  add(
    "graph_get",
    t.tools.get.description,
    z.object({
      id: z.string().describe(t.tools.get.id),
    }),
    async (args) => textResult(graphGet(session, { id: String(args.id) })),
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
    async (args) =>
      textResult(
        await graphSearch(session, {
          q: typeof args.q === "string" ? args.q : undefined,
          types: Array.isArray(args.types) ? (args.types as string[]) : undefined,
          tag: typeof args.tag === "string" ? args.tag : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      ),
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
      async (args) =>
        textResult(
          await graphSimilar(session, {
            id: String(args.id),
            types: Array.isArray(args.types) ? (args.types as string[]) : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          }),
        ),
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
    async (args) =>
      textResult(
        graphNeighbors(session, {
          id: String(args.id),
          edgeTypes: Array.isArray(args.edgeTypes) ? (args.edgeTypes as string[]) : undefined,
          direction: args.direction === "in" || args.direction === "out" ? args.direction : undefined,
          depth: typeof args.depth === "number" ? args.depth : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      ),
  );

  add(
    "graph_snapshot",
    t.tools.snapshot.description,
    z.object({
      types: z.array(z.string()).optional().describe(t.tools.snapshot.types),
      includeText: z.boolean().optional().describe(t.tools.snapshot.includeText),
    }),
    async (args) =>
      textResult(
        graphSnapshot(session, {
          types: Array.isArray(args.types) ? (args.types as string[]) : undefined,
          includeText: args.includeText === true,
        }),
      ),
  );

  add(
    "graph_query",
    queryToolDescription(graphKind, schema, lang),
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

  add(
    "graph_history",
    t.tools.history.description,
    z.object({
      id: z.string().optional(),
      actorId: z.string().optional(),
      since: z.string().optional(),
      limit: z.number().optional().describe(t.tools.history.limit),
    }),
    async (args) =>
      textResult(
        graphHistory(session, {
          id: typeof args.id === "string" ? args.id : undefined,
          actorId: typeof args.actorId === "string" ? args.actorId : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      ),
  );

  add(
    "graph_changes",
    t.tools.changes.description,
    z.object({
      since: z.string().optional().describe(t.tools.changes.since),
      actorId: z.string().optional(),
      limit: z.number().optional().describe(t.tools.changes.limit),
    }),
    async (args) =>
      textResult(
        graphChanges(session, {
          since: typeof args.since === "string" ? args.since : undefined,
          actorId: typeof args.actorId === "string" ? args.actorId : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      ),
  );

  add(
    "graph_actors",
    t.tools.actors,
    z.object({}),
    async () => textResult(graphActors(session)),
  );

  add(
    "graph_delete_node",
    t.tools.deleteNode,
    z.object({ id: z.string() }),
    async (args) => textResult(await deleteGraphNode(session, { id: String(args.id) })),
    destructiveWrite,
  );

  add(
    "graph_delete_edge",
    t.tools.deleteEdge,
    z.object({ id: z.string() }),
    async (args) => textResult(await deleteGraphEdge(session, { id: String(args.id) })),
    destructiveWrite,
  );

  for (const [type, def] of Object.entries(schema.nodes)) {
    const nodeDesc = resolveI18nString(def.description, lang);
    const nodeGuidelines = resolveGuidelines(def.guidelines, lang);
    const desc = t.tools.upsertNode(type, nodeDesc ?? "", guidelinesBlurb(nodeGuidelines, lang));

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

  for (const [type, def] of Object.entries(schema.edges)) {
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
            from: asNodeRef(from),
            to: asNodeRef(to),
            properties,
          }),
        );
      },
      idempotentWrite,
    );
  }

  // Filter generic tools if policy.expose is defined
  if (policy?.expose && policy.expose.length > 0) {
    const exposeSet = new Set(policy.expose);
    tools = tools.filter((tool) => exposeSet.has(tool.name));
  }

  // Register named tools from policy.named
  if (policy?.named) {
    for (const [name, def] of Object.entries(policy.named)) {
      const namedTool = buildNamedTool(name, def, schema, session, lang);
      if (namedTool) {
        tools.push(namedTool);
      }
    }
  }

  // Agent role tool filtering
  if (options.agentRole && policy?.agents) {
    const agent = policy.agents.find(
      (a) => a.role === options.agentRole || a.actorId === options.agentRole,
    );
    if (agent?.tools && agent.tools.length > 0) {
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

  if (createsType) {
    shape.id = z.string().optional().describe(t.tools.namedToolInput.id(createsType));
    if (tagsEnabled) {
      shape.tags = z.array(z.string()).optional().describe(t.tools.namedToolInput.tags);
    }
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

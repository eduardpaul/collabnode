import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { ALL_NODE_TYPES, ALL_TOOLS } from "./agent-policy.js";
import { parseExpression } from "./expr.js";
import { normalizePropertyMap, parseSchemaDocument } from "./parse.js";

import {
  SchemaError,
  type AgentDef,
  type LifecycleDef,
  type NamedToolDef,
  type ParamDef,
  type ProjectionMode,
  type RetentionDef,
  type TemplateDef,
  type ToolsPolicyDef,
  type ViewDef,
  type WorkspaceType,
} from "./types.js";
import { rawWorkspaceType, type RawWorkspaceType } from "./zod-schema.js";

/**
 * Parses duration strings like '30m', '4h', '10s', '500ms', '1d', '2w' or millisecond numbers into milliseconds.
 */
export function parseDuration(value: string | number, path = "duration"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new SchemaError("duration must be a positive number", path);
    }
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new SchemaError("invalid duration string", path);
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i);
  if (!match) {
    throw new SchemaError(
      `invalid duration '${value}'. Expected format like '30m', '4h', '10s', '500ms', '1d'.`,
      path,
    );
  }
  const count = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  switch (unit) {
    case "ms":
      return count;
    case "s":
      return count * 1000;
    case "m":
      return count * 60 * 1000;
    case "h":
      return count * 60 * 60 * 1000;
    case "d":
      return count * 24 * 60 * 60 * 1000;
    case "w":
      return count * 7 * 24 * 60 * 60 * 1000;
    default:
      throw new SchemaError(`unknown duration unit '${unit}'`, path);
  }
}

/**
 * Formats milliseconds into a human-readable duration string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60 * 1000) return `${ms / 1000}s`;
  if (ms < 60 * 60 * 1000) return `${ms / (60 * 1000)}m`;
  if (ms < 24 * 60 * 60 * 1000) return `${ms / (60 * 60 * 1000)}h`;
  return `${ms / (24 * 60 * 60 * 1000)}d`;
}

export function workspaceTypeId(type: WorkspaceType): string {
  return `${type.name}@${type.version}`;
}

function formatZod(error: ZodError): SchemaError {
  const first = error.issues[0];
  const path = first?.path.join(".") ?? "";
  return new SchemaError(first?.message ?? error.message, path);
}

/** Every type a template seeds has to exist, and be seedable the way it is used. */
function assertTemplate(
  schema: WorkspaceType["schema"],
  template: NonNullable<WorkspaceType["template"]>,
): void {
  for (const [i, node] of (template.nodes ?? []).entries()) {
    if (!(node.type in schema.nodes)) {
      throw new SchemaError(
        `template node references undeclared node type '${node.type}'`,
        `template.nodes[${i}].type`,
      );
    }
    // Every iteration would land on the same node, so the seed would read as
    // "one per member" and produce one node holding the last member's values.
    if (node.forEach && schema.nodes[node.type]?.singleton) {
      throw new SchemaError(
        `template node cannot use forEach on singleton node type '${node.type}': every iteration would write to the same node`,
        `template.nodes[${i}].forEach`,
      );
    }
  }
  for (const [i, edge] of (template.edges ?? []).entries()) {
    if (!(edge.type in schema.edges)) {
      throw new SchemaError(
        `template edge references undeclared edge type '${edge.type}'`,
        `template.edges[${i}].type`,
      );
    }
  }
}

/**
 * Names a view may not take, because the generated tool would shadow — or be
 * shadowed by — a tool that already exists. Views are exposed as `view_<name>`,
 * so a view called `node_Epic` would collide with nothing, but one that spells
 * out a whole tool name would.
 */
const RESERVED_TOOL_PREFIXES = ["graph_", "upsert_node_", "upsert_edge_", "view_"];

/** Fields every node carries regardless of its declared properties. */
const PSEUDO_FIELDS = new Set(["id", "type"]);

/**
 * A view names node types, edge types and property names, and carries two
 * expressions. All four are checked here rather than at render time: a typo in
 * a `where` must be a schema error, because `interpolateTemplate` degrades a
 * broken expression to an empty string and a view that silently selects nothing
 * is far worse than one that refuses to load.
 */
function assertViews(
  schema: WorkspaceType["schema"],
  views: Record<string, ViewDef>,
  named: ToolsPolicyDef["named"],
): void {
  for (const [name, view] of Object.entries(views)) {
    const at = `views.${name}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new SchemaError(
        `view name '${name}' must be alphanumeric with underscores, so it can become a tool name`,
        at,
      );
    }
    for (const prefix of RESERVED_TOOL_PREFIXES) {
      if (name.startsWith(prefix)) {
        throw new SchemaError(
          `view name '${name}' must not start with '${prefix}': it is exposed as 'view_${name}' and would shadow a generated tool`,
          at,
        );
      }
    }
    if (named && name in named) {
      throw new SchemaError(`view '${name}' collides with a named tool of the same name`, at);
    }

    const rootTypes = view.select?.roots?.types ?? [];
    for (const [i, type] of rootTypes.entries()) {
      if (!(type in schema.nodes)) {
        throw new SchemaError(
          `view '${name}' selects undeclared node type '${type}'`,
          `${at}.select.roots.types[${i}]`,
        );
      }
    }
    for (const [i, type] of (view.select?.include ?? []).entries()) {
      if (!(type in schema.nodes)) {
        throw new SchemaError(
          `view '${name}' includes undeclared node type '${type}'`,
          `${at}.select.include[${i}]`,
        );
      }
    }
    for (const [i, type] of (view.select?.traverse?.edges ?? []).entries()) {
      if (!(type in schema.edges)) {
        throw new SchemaError(
          `view '${name}' traverses undeclared edge type '${type}'`,
          `${at}.select.traverse.edges[${i}]`,
        );
      }
    }

    for (const [type, fields] of Object.entries(view.fields ?? {})) {
      if (type === ALL_NODE_TYPES) {
        continue;
      }
      const def = schema.nodes[type];
      if (!def) {
        throw new SchemaError(
          `view '${name}' projects fields of undeclared node type '${type}'`,
          `${at}.fields.${type}`,
        );
      }
      for (const [i, field] of fields.entries()) {
        if (!PSEUDO_FIELDS.has(field) && !(field in def.properties)) {
          throw new SchemaError(
            `view '${name}' projects undeclared property '${field}' of node type '${type}'`,
            `${at}.fields.${type}[${i}]`,
          );
        }
      }
    }

    for (const [key, where] of [
      ["select.roots.where", view.select?.roots?.where],
      ["select.traverse.where", view.select?.traverse?.where],
    ] as const) {
      if (where !== undefined) {
        parseExpression(where, `${at}.${key}`);
      }
    }
  }
}

/**
 * Validates consistency of a WorkspaceType against its embedded schema.
 */
export function validateWorkspaceType(wsType: WorkspaceType): void {
  const { schema, template, lifecycle, tools, views } = wsType;

  if (template) {
    assertTemplate(schema, template);
  }

  if (views) {
    assertViews(schema, views, tools?.named);
  }

  if (lifecycle) {
    if (lifecycle.idleTimeout !== undefined) {
      parseDuration(lifecycle.idleTimeout, "lifecycle.idleTimeout");
    }
    if (lifecycle.maxDuration !== undefined) {
      parseDuration(lifecycle.maxDuration, "lifecycle.maxDuration");
    }
  }

  if (tools?.agents) {
    const seen = new Set<string>();
    for (let i = 0; i < tools.agents.length; i++) {
      const agent = tools.agents[i]!;
      if (seen.has(agent.role)) {
        throw new SchemaError(
          `duplicate agent role '${agent.role}'`,
          `tools.agents[${i}].role`,
        );
      }
      seen.add(agent.role);
      for (const [j, view] of (agent.views ?? []).entries()) {
        if (view !== ALL_TOOLS && !(views && view in views)) {
          throw new SchemaError(
            `agent '${agent.role}' grants undeclared view '${view}'`,
            `tools.agents[${i}].views[${j}]`,
          );
        }
      }
      for (const key of ["readOnly", "hidden"] as const) {
        const list = agent.nodes?.[key] ?? [];
        for (let j = 0; j < list.length; j++) {
          const type = list[j]!;
          if (type !== ALL_NODE_TYPES && !(type in schema.nodes)) {
            throw new SchemaError(
              `agent '${agent.role}' ${key} references undeclared node type '${type}'`,
              `tools.agents[${i}].nodes.${key}[${j}]`,
            );
          }
        }
      }
    }
  }

  if (tools?.named) {
    for (const [name, tool] of Object.entries(tools.named)) {
      if (tool.creates && !(tool.creates in schema.nodes)) {
        throw new SchemaError(
          `named tool '${name}' creates undeclared node type '${tool.creates}'`,
          `tools.named.${name}.creates`,
        );
      }
      if (tool.into && !(tool.into in schema.edges)) {
        throw new SchemaError(
          `named tool '${name}' targets undeclared edge type '${tool.into}'`,
          `tools.named.${name}.into`,
        );
      }
    }
  }
}

/**
 * YAML aliases cannot be empty (`- *` is a parse error). Quote a bare `*`
 * list item so `tools.expose: [ * ]` / `- *` reads as the all-tools wildcard
 * (and the same token in `readOnly` / `hidden` / `agents[].tools`).
 *
 * Only block-style items are rewritten; a `*` inside a string is left alone.
 */
export function quoteBareStarListItems(source: string): string {
  return source.replace(/^([ \t]*-[ \t]+)\*([ \t]*(?:#.*)?)$/gm, '$1"*"$2');
}

/**
 * Parses a YAML document into a WorkspaceType bundle.
 */
export function parseWorkspaceTypeDocument(source: string, origin = "<yaml>"): WorkspaceType {
  let parsed: unknown;
  try {
    parsed = parseYaml(quoteBareStarListItems(source), { prettyErrors: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SchemaError(`invalid YAML in ${origin}: ${message}`);
  }

  let raw: RawWorkspaceType;
  try {
    raw = rawWorkspaceType.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      throw formatZod(error);
    }
    throw error;
  }

  const name = raw.type ?? raw.name;
  if (!name) {
    throw new SchemaError("workspace type must specify a 'type' or 'name' property", origin);
  }

  // Construct underlying GraphSchema YAML representation
  const schemaNodes = raw.schema?.nodes ?? raw.nodes ?? {};
  const schemaEdges = raw.schema?.edges ?? raw.edges ?? {};
  const schemaConfig = raw.schema?.config ?? raw.config ?? {
    schemaId: name,
    idStrategy: "uuid",
    changeTracking: { enabled: false, mode: "last-write" },
  };

  const schemaDoc = {
    name: raw.schema?.name ?? name,
    version: raw.schema?.version ?? raw.version,
    description: raw.schema?.description ?? raw.description,
    config: {
      schemaId: schemaConfig.schemaId ?? name,
      idStrategy: schemaConfig.idStrategy ?? "uuid",
      display: schemaConfig.display,
      changeTracking: schemaConfig.changeTracking ?? { enabled: false, mode: "last-write" },
      tags: schemaConfig.tags,
    },
    nodes: schemaNodes,
    edges: schemaEdges,
  };

  // Use parseSchemaDocument to normalize and compute canonical schemaHash
  const schemaYaml = JSON.stringify(schemaDoc);
  const schema = parseSchemaDocument(schemaYaml, origin);

  // Normalize parameters
  let params: Record<string, ParamDef> | undefined;
  if (raw.params) {
    params = {};
    for (const [pName, pDef] of Object.entries(raw.params)) {
      params[pName] = {
        type: pDef.type,
        required: pDef.required,
        default: pDef.default,
        description: pDef.description,
        of: pDef.of,
      };
    }
  }

  // Normalize template
  let template: TemplateDef | undefined;
  if (raw.template) {
    template = {
      nodes: raw.template.nodes?.map((n) => ({
        type: n.type,
        as: n.as,
        id: n.id,
        properties: n.properties,
        tags: n.tags,
        forEach: n.forEach,
        itemVar: n.itemVar,
        indexVar: n.indexVar,
        when: n.when ?? n.if,
      })),
      edges: raw.template.edges?.map((e) => ({
        type: e.type,
        from: e.from,
        to: e.to,
        properties: e.properties,
        id: e.id,
        as: e.as,
        forEach: e.forEach,
        itemVar: e.itemVar,
        indexVar: e.indexVar,
        when: e.when ?? e.if,
      })),
    };
  }

  // Normalize lifecycle
  let lifecycle: LifecycleDef | undefined;
  if (raw.lifecycle) {
    lifecycle = {
      idleTimeout: raw.lifecycle.idleTimeout,
      maxDuration: raw.lifecycle.maxDuration,
      endWhen: raw.lifecycle.endWhen,
    };
  }

  // Normalize tools
  let tools: ToolsPolicyDef | undefined;
  if (raw.tools) {
    const named: Record<string, NamedToolDef> = {};
    if (raw.tools.named) {
      for (const [tName, tDef] of Object.entries(raw.tools.named)) {
        named[tName] = {
          description: tDef.description,
          creates: tDef.creates,
          into: tDef.into,
          properties: tDef.properties ? normalizePropertyMap(tDef.properties) : undefined,
          parameters: tDef.parameters,
        };

      }
    }
    const agents: AgentDef[] = (raw.tools.agents ?? []).map((a) => ({
      role: a.role,
      actorId: a.actorId,
      description: a.description,
      systemPrompt: a.systemPrompt,
      tools: a.tools,
      views: a.views,
      nodes:
        a.nodes && (a.nodes.readOnly?.length || a.nodes.hidden?.length)
          ? { readOnly: a.nodes.readOnly, hidden: a.nodes.hidden }
          : undefined,
      internalPlanning: a.internalPlanning,
    }));
    tools = {
      expose: raw.tools.expose,
      advanced: raw.tools.advanced,
      named: Object.keys(named).length > 0 ? named : undefined,
      agents: agents.length > 0 ? agents : undefined,
    };
  }

  // Views are carried through as declared. Every name they mention is checked
  // against the schema in `validateWorkspaceType`, so nothing here has to guess.
  let views: Record<string, ViewDef> | undefined;
  if (raw.views && Object.keys(raw.views).length > 0) {
    views = {};
    for (const [vName, vDef] of Object.entries(raw.views)) {
      views[vName] = {
        title: vDef.title,
        description: vDef.description,
        guidance: vDef.guidance,
        params: vDef.params
          ? Object.fromEntries(
              Object.entries(vDef.params).map(([pName, pDef]) => [
                pName,
                {
                  type: pDef.type,
                  required: pDef.required,
                  default: pDef.default,
                  description: pDef.description,
                  of: pDef.of,
                } satisfies ParamDef,
              ]),
            )
          : undefined,
        select: vDef.select,
        fields: vDef.fields,
        edges: vDef.edges,
        maxNodes: vDef.maxNodes,
        format: vDef.format,
      };
    }
  }

  const projection: ProjectionMode = raw.projection ?? "none";
  const retention: RetentionDef = {
    onEnd: raw.retention?.onEnd ?? "delete",
    artifact: raw.retention?.artifact ?? "required",
  };

  const wsType: WorkspaceType = {
    name,
    version: raw.version,
    description: raw.description,
    schema,
    params,
    template,
    lifecycle,
    tools,
    views,
    projection,
    retention,
  };

  validateWorkspaceType(wsType);
  return wsType;
}

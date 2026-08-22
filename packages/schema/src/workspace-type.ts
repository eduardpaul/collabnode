import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
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

/**
 * Validates consistency of a WorkspaceType against its embedded schema.
 */
export function validateWorkspaceType(wsType: WorkspaceType): void {
  const { schema, template, lifecycle, tools } = wsType;

  if (template) {
    for (let i = 0; i < (template.nodes ?? []).length; i++) {
      const node = template.nodes![i]!;
      if (!(node.type in schema.nodes)) {
        throw new SchemaError(
          `template node references undeclared node type '${node.type}'`,
          `template.nodes[${i}].type`,
        );
      }
    }
    for (let i = 0; i < (template.edges ?? []).length; i++) {
      const edge = template.edges![i]!;
      if (!(edge.type in schema.edges)) {
        throw new SchemaError(
          `template edge references undeclared edge type '${edge.type}'`,
          `template.edges[${i}].type`,
        );
      }
    }
  }

  if (lifecycle) {
    if (lifecycle.idleTimeout !== undefined) {
      parseDuration(lifecycle.idleTimeout, "lifecycle.idleTimeout");
    }
    if (lifecycle.maxDuration !== undefined) {
      parseDuration(lifecycle.maxDuration, "lifecycle.maxDuration");
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
 * Parses a YAML document into a WorkspaceType bundle.
 */
export function parseWorkspaceTypeDocument(source: string, origin = "<yaml>"): WorkspaceType {
  let parsed: unknown;
  try {
    parsed = parseYaml(source, { prettyErrors: true });
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
    }));
    tools = {
      expose: raw.tools.expose,
      named: Object.keys(named).length > 0 ? named : undefined,
      agents: agents.length > 0 ? agents : undefined,
    };
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
    projection,
    retention,
  };

  validateWorkspaceType(wsType);
  return wsType;
}

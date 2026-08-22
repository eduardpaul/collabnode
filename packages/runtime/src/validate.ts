import type {
  GraphNodeRecord,
  GraphSnapshot,
  PropertyMap,
  PropertyValue,
} from "@collabnode/graph";
import type { GraphSchema, PropertyDef } from "@collabnode/schema";
import { isCrdtPropertyType, SchemaError } from "@collabnode/schema";

export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 32;

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function coerceProperty(
  def: PropertyDef,
  value: unknown,
  path: string,
): PropertyValue {
  if (value === undefined || value === null) {
    if (def.default !== undefined) {
      return coerceProperty(def, def.default, path);
    }
    return null;
  }
  switch (def.type) {
    case "string":
    case "enum":
      if (typeof value !== "string") {
        throw new SchemaError(`expected string`, path);
      }
      if (def.type === "enum" && def.values && !def.values.includes(value)) {
        throw new SchemaError(`expected one of ${def.values.join(", ")}`, path);
      }
      if (def.maxLength !== undefined && value.length > def.maxLength) {
        throw new SchemaError(`expected string of length <= ${def.maxLength}`, path);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SchemaError(`expected finite number`, path);
      }
      if (def.integer && !Number.isInteger(value)) {
        throw new SchemaError(`expected integer`, path);
      }
      if (def.min !== undefined && value < def.min) {
        throw new SchemaError(`expected number >= ${def.min}`, path);
      }
      if (def.max !== undefined && value > def.max) {
        throw new SchemaError(`expected number <= ${def.max}`, path);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new SchemaError(`expected boolean`, path);
      }
      return value;
    case "datetime":
      if (typeof value !== "string" || !isIsoDate(value)) {
        throw new SchemaError(`expected ISO-8601 datetime string`, path);
      }
      return value;
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "text":
      if (typeof value !== "string") {
        throw new SchemaError(`expected string`, path);
      }
      return value;
    case "map":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new SchemaError(`expected object`, path);
      }
      return value as { [key: string]: unknown };
    case "array":
      if (!Array.isArray(value)) {
        throw new SchemaError(`expected array`, path);
      }
      return value;
    default: {
      const _never: never = def.type;
      return _never;
    }
  }
}

function assertKnownProperties(
  defs: Record<string, PropertyDef>,
  input: Record<string, unknown>,
  path: string,
): void {
  const extra = Object.keys(input).filter((key) => !(key in defs));
  if (extra.length > 0) {
    throw new SchemaError(`unknown properties: ${extra.join(", ")}`, path);
  }
}

function mergeProperties(
  defs: Record<string, PropertyDef>,
  existing: PropertyMap,
  input: Record<string, unknown>,
  path: string,
): PropertyMap {
  assertKnownProperties(defs, input, path);
  const result: PropertyMap = { ...existing };
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    const def = defs[name]!;
    if (def.derived !== undefined || isCrdtPropertyType(def.type)) {
      continue;
    }
    if (value === null) {
      if (def.required) {
        throw new SchemaError(`missing required property '${name}'`, path);
      }
      delete result[name];
      continue;
    }
    result[name] = coerceProperty(def, value, `${path}.${name}`);
  }
  for (const [name, def] of Object.entries(defs)) {
    if (!def.required || def.default !== undefined || def.derived !== undefined || isCrdtPropertyType(def.type)) {
      continue;
    }
    const value = result[name];
    if (value === undefined || value === null) {
      throw new SchemaError(`missing required property '${name}'`, path);
    }
  }
  return result;
}

export function coerceProperties(
  defs: Record<string, PropertyDef>,
  input: Record<string, unknown>,
  path: string,
  existing?: PropertyMap,
): PropertyMap {
  if (existing) {
    return mergeProperties(defs, existing, input, path);
  }
  assertKnownProperties(defs, input, path);
  const result: PropertyMap = {};
  for (const [name, def] of Object.entries(defs)) {
    if (def.derived !== undefined || isCrdtPropertyType(def.type)) {
      continue;
    }
    const value = input[name];
    if ((value === undefined || value === null) && def.required && def.default === undefined) {
      throw new SchemaError(`missing required property '${name}'`, path);
    }
    const coerced = coerceProperty(def, value, `${path}.${name}`);
    if (coerced !== null) {
      result[name] = coerced;
    } else if (def.default !== undefined) {
      result[name] = coerceProperty(def, def.default, `${path}.${name}`);
    }
  }
  return result;
}

export function assertNodeOp(
  schema: GraphSchema,
  type: string,
  properties: Record<string, unknown>,
  existing?: PropertyMap,
): PropertyMap {
  const def = schema.nodes[type];
  if (!def) {
    throw new SchemaError(`unknown node type '${type}'`, "type");
  }
  return coerceProperties(def.properties, properties, `nodes.${type}`, existing);
}

export function normalizeTags(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new SchemaError(`tag exceeds ${MAX_TAG_LENGTH} characters`, "tags");
    }
    const folded = trimmed.toLowerCase();
    if (seen.has(folded)) {
      continue;
    }
    seen.add(folded);
    out.push(trimmed);
  }
  if (out.length > MAX_TAGS) {
    throw new SchemaError(`at most ${MAX_TAGS} tags per node`, "tags");
  }
  return out;
}

export function resolveNodeTags(
  schema: GraphSchema,
  input: string[] | undefined,
  existing: string[] | undefined,
): { tags: string[] | undefined; replaced: boolean } {
  if (input === undefined) {
    return { tags: existing ? [...existing] : undefined, replaced: false };
  }
  if (!schema.config.tags?.enabled) {
    throw new SchemaError("tags are not enabled on this schema (set config.tags.enabled)", "tags");
  }
  return { tags: normalizeTags(input), replaced: true };
}

export function assertEdgeOp(
  schema: GraphSchema,
  snapshot: GraphSnapshot,
  type: string,
  from: string,
  to: string,
  properties: Record<string, unknown>,
  existing?: PropertyMap,
): PropertyMap {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return assertEdgeOpWith(schema, (id) => nodes.get(id), type, from, to, properties, existing);
}

/**
 * The same checks against a node lookup rather than a snapshot.
 *
 * Endpoint validation is two `find` calls per edge; on a batch that is two
 * scans of the whole graph per edge, so the caller passes an index it already
 * built instead of rebuilding one here.
 */
export function assertEdgeOpWith(
  schema: GraphSchema,
  lookup: (id: string) => GraphNodeRecord | undefined,
  type: string,
  from: string,
  to: string,
  properties: Record<string, unknown>,
  existing?: PropertyMap,
): PropertyMap {
  const def = schema.edges[type];
  if (!def) {
    throw new SchemaError(`unknown edge type '${type}'`, "type");
  }
  const fromNode = lookup(from);
  const toNode = lookup(to);
  if (!fromNode) {
    throw new SchemaError(`edge '${type}' from-id '${from}' does not exist`, "from");
  }
  if (!toNode) {
    throw new SchemaError(`edge '${type}' to-id '${to}' does not exist`, "to");
  }
  if (!def.from.includes(fromNode.type)) {
    throw new SchemaError(
      `edge '${type}' cannot start from node type '${fromNode.type}'`,
      "from",
    );
  }
  if (!def.to.includes(toNode.type)) {
    throw new SchemaError(`edge '${type}' cannot end at node type '${toNode.type}'`, "to");
  }
  return coerceProperties(def.properties, properties, `edges.${type}`, existing);
}



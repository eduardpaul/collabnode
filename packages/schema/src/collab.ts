import type { CrdtPropertyType, GraphSchema, NodeTypeDef, PropertyDef } from "./types.js";
import { isCrdtPropertyType, SchemaError } from "./types.js";

export function crdtProperties(def: NodeTypeDef | undefined): Record<string, CrdtPropertyType> {
  const result: Record<string, CrdtPropertyType> = {};
  for (const [name, property] of Object.entries(def?.properties ?? {})) {
    if (isCrdtPropertyType(property.type)) {
      result[name] = property.type;
    }
  }
  return result;
}

export function lwwProperties(def: NodeTypeDef): Record<string, PropertyDef> {
  const result: Record<string, PropertyDef> = {};
  for (const [name, property] of Object.entries(def.properties)) {
    if (!isCrdtPropertyType(property.type)) {
      result[name] = property;
    }
  }
  return result;
}

export function partitionNodeProperties(
  def: NodeTypeDef,
  input: Record<string, unknown>,
): { scalars: Record<string, unknown>; crdt: Record<string, unknown> } {
  const scalars: Record<string, unknown> = {};
  const crdt: Record<string, unknown> = {};
  const extra: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const property = def.properties[key];
    if (!property) {
      extra.push(key);
    } else if (isCrdtPropertyType(property.type)) {
      crdt[key] = value;
    } else {
      scalars[key] = value;
    }
  }
  if (extra.length > 0) {
    throw new SchemaError(`unknown properties: ${extra.join(", ")}`, "properties");
  }
  for (const [key, value] of Object.entries(crdt)) {
    const type = def.properties[key]?.type;
    if (type === "text") {
      crdt[key] = coerceTextValue(value, `properties.${key}`);
    }
    if (type === "map" && (value === null || typeof value !== "object" || Array.isArray(value))) {
      throw new SchemaError(`expected object`, `properties.${key}`);
    }
    if (type === "array" && !Array.isArray(value)) {
      throw new SchemaError(`expected array`, `properties.${key}`);
    }
  }
  return { scalars, crdt };
}

function coerceTextValue(value: unknown, path: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    throw new SchemaError(`expected string`, path);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text: unknown }).text);
        }
        return String(item);
      })
      .join("\n");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text: unknown }).text);
  }
  throw new SchemaError(`expected string`, path);
}

export function assertCrdtField(
  schema: GraphSchema,
  nodeType: string,
  field: string,
  kind: CrdtPropertyType,
): void {
  const def = schema.nodes[nodeType];
  if (!def) {
    throw new SchemaError(`unknown node type '${nodeType}'`, "type");
  }
  const property = def.properties[field];
  if (!property || property.type !== kind) {
    throw new SchemaError(`node type '${nodeType}' has no ${kind} property '${field}'`, `properties.${field}`);
  }
}

export function fillRequiredCrdt(
  def: NodeTypeDef,
  crdt: Record<string, unknown>,
  path: string,
  isCreate: boolean,
): Record<string, unknown> {
  if (!isCreate) {
    return crdt;
  }
  const result = { ...crdt };
  for (const [name, property] of Object.entries(def.properties)) {
    if (!isCrdtPropertyType(property.type)) {
      continue;
    }
    if (result[name] !== undefined) {
      continue;
    }
    if (property.default !== undefined) {
      result[name] = property.default;
      continue;
    }
    if (property.required) {
      throw new SchemaError(`missing required property '${name}'`, path);
    }
  }
  return result;
}

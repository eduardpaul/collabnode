import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { arithmeticIdentifiers, parseArithmeticExpression } from "./expr.js";
import { sha256Canonical } from "./hash.js";
import { resolveGuidelines } from "./i18n.js";
import type {
  EdgeTypeDef,
  GraphSchema,
  NodeTypeDef,
  PropertyDef,
  PropertySearch,
  PropertyVector,
} from "./types.js";
import {
  DEFAULT_IDENTITY_BOOST,
  DEFAULT_SEARCH_BOOST,
  isCrdtPropertyType,
  SchemaError,
} from "./types.js";
import { rawSchema, type RawProperty, type RawSchema } from "./zod-schema.js";

const RESERVED_PROPERTY_NAMES = new Set(["id"]);

function formatZod(error: ZodError): SchemaError {
  const first = error.issues[0];
  const path = first?.path.join(".") ?? "";
  return new SchemaError(first?.message ?? error.message, path);
}

function assertPropertyMap(properties: Record<string, RawProperty>, path: string): void {
  for (const name of Object.keys(properties)) {
    if (RESERVED_PROPERTY_NAMES.has(name) || name.startsWith("_")) {
      throw new SchemaError(
        `property name '${name}' is reserved (id and names starting with _ are used by the runtime)`,
        `${path}.${name}`,
      );
    }
  }
}

function assertNoDerived(properties: Record<string, RawProperty>, path: string): void {
  for (const [name, def] of Object.entries(properties)) {
    if (def.derived !== undefined) {
      throw new SchemaError("`derived` is only valid on node properties", `${path}.${name}.derived`);
    }
  }
}

function assertDerivedExpressions(properties: Record<string, RawProperty>, path: string): void {
  for (const [name, def] of Object.entries(properties)) {
    if (def.derived === undefined) {
      continue;
    }
    if (def.type !== "number") {
      throw new SchemaError("`derived` is only valid on number properties", `${path}.${name}.derived`);
    }
    if (def.required) {
      throw new SchemaError("`required` cannot be combined with `derived`", `${path}.${name}`);
    }
    if (def.default !== undefined) {
      throw new SchemaError("`default` cannot be combined with `derived`", `${path}.${name}`);
    }
    const exprPath = `${path}.${name}.derived`;
    const expr = parseArithmeticExpression(def.derived, exprPath);
    for (const ident of arithmeticIdentifiers(expr)) {
      const target = properties[ident];
      if (!target) {
        throw new SchemaError(
          `derived expression references unknown property '${ident}'`,
          exprPath,
        );
      }
      if (target.derived !== undefined) {
        throw new SchemaError(
          `derived expression cannot reference derived property '${ident}'`,
          exprPath,
        );
      }
      if (target.type !== "number") {
        throw new SchemaError(
          `derived expression identifier '${ident}' must refer to a number property`,
          exprPath,
        );
      }
    }
  }
}

function assignIfDefined<K extends keyof PropertyDef>(
  target: PropertyDef,
  key: K,
  value: PropertyDef[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function normalizeSearch(
  raw: RawProperty["search"],
  isIdentity: boolean,
): PropertySearch | undefined {
  const defaultBoost = isIdentity ? DEFAULT_IDENTITY_BOOST : DEFAULT_SEARCH_BOOST;
  if (raw === undefined) {
    // Left absent on purpose: materializing a default here would change
    // schemaHash for every schema that never mentions `search`. The implicit
    // default lives in the search index instead.
    return undefined;
  }
  if (typeof raw === "boolean") {
    return { index: raw, boost: defaultBoost };
  }
  return {
    index: raw.index ?? true,
    boost: raw.boost ?? defaultBoost,
  };
}

/**
 * No implicit default here, deliberately: embedding every text field of every
 * schema would pull in an embedding model nobody asked for. Semantic search is
 * opt-in per property, and its absence is a real answer.
 */
function normalizeVector(raw: RawProperty["vector"]): PropertyVector | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "boolean") {
    return { index: raw };
  }
  return { index: raw.index ?? true };
}

function normalizeProperty(property: RawProperty, isIdentity: boolean): PropertyDef {
  const out: PropertyDef = { type: property.type };
  assignIfDefined(out, "required", property.required);
  assignIfDefined(out, "default", property.default);
  assignIfDefined(out, "values", property.values);
  assignIfDefined(out, "description", property.description);
  assignIfDefined(out, "min", property.min);
  assignIfDefined(out, "max", property.max);
  assignIfDefined(out, "integer", property.integer);
  assignIfDefined(out, "maxLength", property.maxLength);
  assignIfDefined(out, "derived", property.derived);
  if (property.ui !== undefined) {
    const ui: NonNullable<PropertyDef["ui"]> = {};
    if (property.ui.widget !== undefined) {
      ui.widget = property.ui.widget;
    }
    if (property.ui.label !== undefined) {
      ui.label = property.ui.label;
    }
    out.ui = ui;
  }
  const search = normalizeSearch(property.search, isIdentity);
  if (search !== undefined) {
    out.search = search;
  }
  const vector = normalizeVector(property.vector);
  if (vector !== undefined) {
    out.vector = vector;
  }
  return out;
}

export function normalizePropertyMap(
  properties: Record<string, RawProperty>,
  identityFields: readonly string[] = [],
): Record<string, PropertyDef> {

  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      normalizeProperty(property, identityFields.includes(name)),
    ]),
  );
}

function normalize(raw: RawSchema): Omit<GraphSchema, "schemaHash"> {
  const nodes: Record<string, NodeTypeDef> = {};
  for (const [name, node] of Object.entries(raw.nodes)) {
    assertPropertyMap(node.properties, `nodes.${name}.properties`);
    assertDerivedExpressions(node.properties, `nodes.${name}.properties`);
    if (node.identity) {
      for (const field of node.identity.from) {
        const property = node.properties[field];
        if (!property) {
          throw new SchemaError(
            `identity field '${field}' is not a property of node type '${name}'`,
            `nodes.${name}.identity.from`,
          );
        }
        if (isCrdtPropertyType(property.type)) {
          throw new SchemaError(
            `identity field '${field}' cannot be a ${property.type} property`,
            `nodes.${name}.identity.from`,
          );
        }
      }
    }
    nodes[name] = {
      description: node.description,
      identity: node.identity,
      properties: normalizePropertyMap(node.properties, node.identity?.from ?? []),
      ui: node.ui,
      guidelines: node.guidelines,
    };
  }

  const edges: Record<string, EdgeTypeDef> = {};
  for (const [name, edge] of Object.entries(raw.edges)) {
    assertPropertyMap(edge.properties, `edges.${name}.properties`);
    assertNoDerived(edge.properties, `edges.${name}.properties`);
    for (const [field, property] of Object.entries(edge.properties)) {
      if (isCrdtPropertyType(property.type)) {
        throw new SchemaError(
          `edge properties cannot be ${property.type} (text/map/array are node-only)`,
          `edges.${name}.properties.${field}`,
        );
      }
    }
    for (const endpoint of edge.from) {
      if (!(endpoint in nodes)) {
        throw new SchemaError(
          `edge '${name}' from-type '${endpoint}' is not a declared node type`,
          `edges.${name}.from`,
        );
      }
    }
    for (const endpoint of edge.to) {
      if (!(endpoint in nodes)) {
        throw new SchemaError(
          `edge '${name}' to-type '${endpoint}' is not a declared node type`,
          `edges.${name}.to`,
        );
      }
    }
    edges[name] = {
      description: edge.description,
      from: edge.from,
      to: edge.to,
      directed: edge.directed ?? true,
      properties: normalizePropertyMap(edge.properties),
      ui: edge.ui,
      guidelines: edge.guidelines,
    };
  }

  return {
    name: raw.name,
    version: raw.version,
    description: raw.description,
    config: {
      schemaId: raw.config.schemaId,
      idStrategy: raw.config.idStrategy,
      display: raw.config.display,
      changeTracking: {
        enabled: raw.config.changeTracking?.enabled ?? false,
        mode: raw.config.changeTracking?.mode ?? "last-write",
        ...(raw.config.changeTracking?.historyLimit !== undefined
          ? { historyLimit: raw.config.changeTracking.historyLimit }
          : {}),
      },
      ...(raw.config.tags ? { tags: { enabled: raw.config.tags.enabled } } : {}),
    },
    nodes,
    edges,
  };
}

export function parseSchemaDocument(source: string, origin = "<yaml>"): GraphSchema {
  let parsed: unknown;
  try {
    parsed = parseYaml(source, { prettyErrors: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SchemaError(`invalid YAML in ${origin}: ${message}`);
  }

  let raw: RawSchema;
  try {
    raw = rawSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      throw formatZod(error);
    }
    throw error;
  }

  const normalized = normalize(raw);
  const schemaHash = sha256Canonical(normalized);
  return { ...normalized, schemaHash };
}

export function uiFor(
  schema: GraphSchema,
  kind: "node" | "edge",
  type: string,
): NodeTypeDef["ui"] {
  return kind === "node" ? schema.nodes[type]?.ui : schema.edges[type]?.ui;
}

export function guidelinesFor(
  schema: GraphSchema,
  kind: "node" | "edge",
  type: string,
  language?: string,
): string[] {
  const list =
    kind === "node" ? schema.nodes[type]?.guidelines : schema.edges[type]?.guidelines;
  return resolveGuidelines(list, language);
}

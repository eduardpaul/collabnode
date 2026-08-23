import type { GraphSchema, PropertyDef } from "./types.js";
import { resolveI18nString } from "./i18n.js";

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  default?: unknown;
  items?: JsonSchemaProperty;
  additionalProperties?: boolean | JsonSchemaProperty;
}

export interface JsonSchemaObject {
  type: "object";
  title?: string;
  description?: string;
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Converts a Collabnode PropertyDef into a standard JSON Schema property descriptor.
 */
export function propertyDefToJsonSchema(
  prop: PropertyDef,
  language?: string,
): JsonSchemaProperty {
  const schema: JsonSchemaProperty = { type: "string" };

  if (prop.description) {
    schema.description = resolveI18nString(prop.description, language);
  }

  if (prop.default !== undefined) {
    schema.default = prop.default;
  }

  switch (prop.type) {
    case "string":
    case "text":
      schema.type = "string";
      if (prop.maxLength !== undefined) schema.maxLength = prop.maxLength;
      break;
    case "number":
      schema.type = prop.integer ? "integer" : "number";
      if (prop.min !== undefined) schema.minimum = prop.min;
      if (prop.max !== undefined) schema.maximum = prop.max;
      break;
    case "boolean":
      schema.type = "boolean";
      break;
    case "datetime":
      schema.type = "string";
      schema.description = (schema.description ? `${schema.description} ` : "") + "(ISO 8601 datetime format)";
      break;
    case "enum":
      schema.type = "string";
      if (prop.values) {
        schema.enum = [...prop.values];
      }
      break;
    case "array":
      schema.type = "array";
      schema.items = { type: "string" };
      break;
    case "map":
    case "json":
      schema.type = "object";
      schema.additionalProperties = true;
      break;
  }

  return schema;
}

/**
 * Converts a Collabnode NodeTypeDef into a standard JSON Schema object descriptor,
 * suitable for LLM structured output enforcement (OpenAI json_schema, LangChain withStructuredOutput, etc.).
 */
export function nodeTypeToJsonSchema(
  schema: GraphSchema,
  nodeTypeName: string,
  language?: string,
): JsonSchemaObject {
  const nodeDef = schema.nodes[nodeTypeName];
  if (!nodeDef) {
    throw new Error(`Node type '${nodeTypeName}' not found in schema '${schema.name}'`);
  }

  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const [key, prop] of Object.entries(nodeDef.properties)) {
    properties[key] = propertyDefToJsonSchema(prop, language);
    if (prop.required) {
      required.push(key);
    }
  }

  return {
    type: "object",
    title: nodeTypeName,
    description: nodeDef.description ? resolveI18nString(nodeDef.description, language) : undefined,
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

/**
 * Converts all node types in a GraphSchema into standard JSON Schema descriptors.
 */
export function schemaToJsonSchema(
  schema: GraphSchema,
  language?: string,
): Record<string, JsonSchemaObject> {
  const result: Record<string, JsonSchemaObject> = {};
  for (const nodeTypeName of Object.keys(schema.nodes)) {
    result[nodeTypeName] = nodeTypeToJsonSchema(schema, nodeTypeName, language);
  }
  return result;
}

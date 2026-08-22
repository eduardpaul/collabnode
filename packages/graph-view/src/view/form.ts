import {
  guidelinesFor,
  isCrdtPropertyType,
  resolveI18nString,
  type GraphSchema,
  type PropertyDef,
  type PropertyTypeName,
  type PropertyWidget,
} from "@collabnode/schema";

export interface FieldDescriptor {
  name: string;
  type: PropertyTypeName;
  required: boolean;
  description?: string;
  values?: string[];
  default?: unknown;
  min?: number;
  max?: number;
  integer?: boolean;
  maxLength?: number;
  widget?: PropertyWidget;
  label?: string;
  derived?: string;
}

export type FieldWidget =
  | "hidden"
  | "checkbox"
  | "enum"
  | "slider"
  | "number"
  | "datetime"
  | "json"
  | "textarea"
  | "text";

export function fieldWidget(field: FieldDescriptor): FieldWidget {
  if (field.widget === "hidden") {
    return "hidden";
  }
  switch (field.type) {
    case "boolean":
      return "checkbox";
    case "enum":
      return "enum";
    case "datetime":
      return "datetime";
    case "json":
    case "map":
    case "array":
      return "json";
    case "text":
      return "textarea";
    case "number":
      if (
        field.widget === "slider" &&
        field.integer === true &&
        field.min !== undefined &&
        field.max !== undefined
      ) {
        return "slider";
      }
      return "number";
    default:
      if (
        field.widget === "textarea" ||
        (field.widget !== "text" && field.maxLength !== undefined && field.maxLength > 200)
      ) {
        return "textarea";
      }
      return "text";
  }
}

export type ParseResult =
  | { ok: true; properties: Record<string, unknown> }
  | { ok: false; error: string };

export function fieldsFor(
  schema: GraphSchema,
  kind: "node" | "edge",
  type: string,
  options?: { crdt?: "include" | "omit" },
): FieldDescriptor[] {
  const def = kind === "node" ? schema.nodes[type] : schema.edges[type];
  if (!def) {
    return [];
  }
  const fields = Object.entries(def.properties).map(([name, property]) => toField(name, property));
  if (options?.crdt === "omit") {
    return fields.filter((field) => !isCrdtPropertyType(field.type));
  }
  return fields;
}

function toField(name: string, property: PropertyDef): FieldDescriptor {
  return {
    name,
    type: property.type,
    required: property.required === true,
    description: resolveI18nString(property.description),
    values: property.values,
    default: property.default,
    min: property.min,
    max: property.max,
    integer: property.integer,
    maxLength: property.maxLength,
    widget: property.ui?.widget,
    label: resolveI18nString(property.ui?.label),
    derived: property.derived,
  };
}

export function defaultsFor(fields: FieldDescriptor[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.default !== undefined) {
      values[field.name] = field.default;
    } else if (field.type === "boolean") {
      values[field.name] = false;
    } else if (field.type === "enum" && field.values?.[0] !== undefined) {
      values[field.name] = field.values[0];
    }
  }
  return values;
}

export function toDatetimeLocal(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.length >= 16 ? value.slice(0, 16) : value;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDatetimeLocal(value: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString();
}

export function propertiesFromForm(
  fields: FieldDescriptor[],
  raw: Record<string, string | boolean>,
  options?: { emptyAs?: "omit" | "null" },
): ParseResult {
  const properties: Record<string, unknown> = {};
  const emptyAs = options?.emptyAs ?? "omit";
  for (const field of fields) {
    if (field.derived !== undefined) {
      continue;
    }
    const incoming = raw[field.name];
    const empty =
      incoming === undefined ||
      incoming === "" ||
      incoming === null ||
      (field.type !== "boolean" && incoming === false);
    if (empty) {
      if (field.required) {
        return { ok: false, error: `${field.name} is required` };
      }
      // Inspect/update is a merge patch: omit keeps the previous value.
      if (emptyAs === "null") {
        properties[field.name] = null;
      }
      continue;
    }
    try {
      properties[field.name] = parseValue(field, incoming);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: true, properties };
}

function parseValue(field: FieldDescriptor, incoming: string | boolean): unknown {
  switch (field.type) {
    case "boolean":
      return incoming === true || incoming === "true" || incoming === "on";
    case "number": {
      const n = typeof incoming === "number" ? incoming : Number(incoming);
      if (!Number.isFinite(n)) {
        throw new Error(`${field.name} must be a number`);
      }
      if (field.integer && !Number.isInteger(n)) {
        throw new Error(`${field.name} must be an integer`);
      }
      if (field.min !== undefined && n < field.min) {
        throw new Error(`${field.name} must be >= ${field.min}`);
      }
      if (field.max !== undefined && n > field.max) {
        throw new Error(`${field.name} must be <= ${field.max}`);
      }
      return n;
    }
    case "datetime":
      return fromDatetimeLocal(String(incoming));
    case "json":
    case "map":
    case "array": {
      try {
        return JSON.parse(String(incoming));
      } catch {
        throw new Error(`${field.name} must be valid JSON`);
      }
    }
    case "text":
      return String(incoming);
    case "enum": {
      const value = String(incoming);
      if (field.values && !field.values.includes(value)) {
        throw new Error(`${field.name} must be one of ${field.values.join(", ")}`);
      }
      return value;
    }
    default: {
      const value = String(incoming);
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        throw new Error(`${field.name} must be at most ${field.maxLength} characters`);
      }
      return value;
    }
  }
}

export function typeGuidelines(
  schema: GraphSchema,
  kind: "node" | "edge",
  type: string,
): string[] {
  return guidelinesFor(schema, kind, type);
}

export function parseTagsInput(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function sameTagList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((tag, index) => tag.toLowerCase() === b[index]!.toLowerCase());
}

/** Omit tags when the inspector value matches the loaded node so unrelated saves do not LWW tagsJson. */
export function tagsFromForm(
  schema: GraphSchema,
  raw: Record<string, string | boolean>,
  existing?: string[],
): string[] | undefined {
  if (!schema.config.tags?.enabled) {
    return undefined;
  }
  const value = raw._tags;
  const parsed = typeof value === "string" ? parseTagsInput(value) : [];
  if (existing !== undefined && sameTagList(parsed, existing)) {
    return undefined;
  }
  return parsed;
}

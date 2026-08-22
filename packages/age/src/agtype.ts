import type { EntityMeta, PropertyMap, PropertyValue } from "@collabnode/graph";

const AGE_SUFFIX = /::(vertex|edge|path)$/;

function asPropertyValue(value: unknown): PropertyValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

function pickMeta(properties: Record<string, unknown>): {
  properties: PropertyMap;
  meta: EntityMeta;
} {
  const meta: EntityMeta = {};
  const rest: PropertyMap = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key === "createdAt" || key === "createdBy" || key === "updatedAt" || key === "updatedBy") {
      if (typeof value === "string") {
        meta[key] = value;
      }
      continue;
    }
    rest[key] = asPropertyValue(value);
  }
  return { properties: rest, meta };
}

export function parseAgtype(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  const stripped = value.replace(AGE_SUFFIX, "");
  try {
    return JSON.parse(stripped);
  } catch {
    return value;
  }
}

function isAgeEntity(
  value: unknown,
): value is { id: unknown; label: string; properties?: Record<string, unknown>; start_id?: unknown; end_id?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    "label" in value &&
    typeof (value as { label: unknown }).label === "string" &&
    "properties" in value
  );
}

export function decodeAgeValue(value: unknown): unknown {
  const parsed = parseAgtype(value);
  if (!isAgeEntity(parsed)) {
    return parsed;
  }
  const rawProps = parsed.properties ?? {};
  const { properties, meta } = pickMeta(rawProps);
  const isEdge = parsed.start_id !== undefined || parsed.end_id !== undefined;
  if (isEdge) {
    const id = typeof properties.collabId === "string" ? properties.collabId : String(parsed.id);
    const { collabId: _collabId, ...rest } = properties;
    return { id, type: parsed.label, properties: rest, meta };
  }
  const id =
    typeof properties.collabId === "string"
      ? properties.collabId
      : typeof properties.id === "string"
        ? properties.id
        : String(parsed.id);
  const { id: _id, collabId: _collabId, ...rest } = properties;
  return { id, type: parsed.label, properties: rest, meta };
}

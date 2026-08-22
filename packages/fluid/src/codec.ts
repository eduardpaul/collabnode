import type {
  EntityMeta,
  GraphEdgeRecord,
  GraphNodeRecord,
  HistoryEntry,
  PropertyMap,
  PropertyValue,
} from "@collabnode/graph";
import { emptyMeta } from "@collabnode/graph";

export function encodePropertyValue(value: PropertyValue): string {
  return JSON.stringify(value);
}

export function decodePropertyValue(json: string): PropertyValue {
  if (!json) {
    return null;
  }
  return JSON.parse(json) as PropertyValue;
}

export function decodePropertyMap(map: Iterable<[string, string]>): PropertyMap {
  const properties: PropertyMap = {};
  for (const [key, json] of map) {
    properties[key] = decodePropertyValue(json);
  }
  return properties;
}

export function encodePropertyEntries(properties: PropertyMap): Array<[string, string]> {
  return Object.entries(properties).map(([key, value]) => [key, encodePropertyValue(value)]);
}

export function encodeMeta(meta: EntityMeta): string {
  return JSON.stringify(meta);
}

export function decodeMeta(json: string): EntityMeta {
  if (!json) {
    return emptyMeta();
  }
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyMeta();
  }
  return parsed as EntityMeta;
}

export function encodeTags(tags: string[]): string {
  return JSON.stringify(tags);
}

export function decodeTags(json: string): string[] {
  if (!json) {
    return [];
  }
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is string => typeof item === "string");
}

export function encodeHistoryEntry(entry: HistoryEntry): string {
  return JSON.stringify(entry);
}

export function decodeHistoryEntry(json: string): HistoryEntry | undefined {
  if (!json) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Partial<HistoryEntry>;
    if (typeof record.opId !== "string" || typeof record.op !== "string" || typeof record.id !== "string") {
      return undefined;
    }
    return record as HistoryEntry;
  } catch {
    return undefined;
  }
}

export function nodeRecord(
  id: string,
  type: string,
  properties: PropertyMap,
  metaJson: string,
  tagsJson = "[]",
): GraphNodeRecord {
  return {
    id,
    type,
    properties,
    tags: decodeTags(tagsJson),
    meta: decodeMeta(metaJson),
  };
}

export function edgeRecord(
  id: string,
  type: string,
  from: string,
  to: string,
  properties: PropertyMap,
  metaJson: string,
): GraphEdgeRecord {
  return {
    id,
    type,
    from,
    to,
    properties,
    meta: decodeMeta(metaJson),
  };
}

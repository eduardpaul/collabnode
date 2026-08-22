import type { GraphEdgeRecord, GraphNodeRecord, PropertyMap } from "@collabnode/graph";
import { resolveI18nString, uiFor, type GraphSchema } from "@collabnode/schema";
import { colorForValue, darken, hashColor, isHexColor } from "./palette.js";

const FALLBACK_LABEL_KEYS = ["title", "name", "claim", "body", "channel"] as const;

const ICON_SHAPES: Record<string, string> = {
  dot: "dot",
  circle: "dot",
  box: "box",
  square: "box",
  "check-square": "box",
  diamond: "diamond",
  ellipse: "ellipse",
  triangle: "triangle",
  hexagon: "hexagon",
  star: "star",
};

export function interpolateLabel(template: string, properties: PropertyMap): string {
  const filled = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) => {
    const value = properties[key];
    if (value === undefined || value === null || value === "") {
      return "";
    }
    return String(value);
  });
  return filled.replace(/\s+/g, " ").trim();
}

export function fallbackLabel(type: string, properties: PropertyMap, id: string): string {
  for (const key of FALLBACK_LABEL_KEYS) {
    const value = properties[key];
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  return `${type} ${id.slice(0, 8)}`;
}

export function nodeLabel(schema: GraphSchema, node: GraphNodeRecord): string {
  const template = resolveI18nString(uiFor(schema, "node", node.type)?.label);
  if (template) {
    const label = interpolateLabel(template, node.properties);
    if (label) {
      return label;
    }
  }
  return fallbackLabel(node.type, node.properties, node.id);
}

export function edgeLabel(schema: GraphSchema, edge: GraphEdgeRecord): string {
  const template = resolveI18nString(uiFor(schema, "edge", edge.type)?.label);
  if (template) {
    const label = interpolateLabel(template, edge.properties);
    if (label) {
      return label;
    }
  }
  return edge.type.replaceAll("_", " ").toLowerCase();
}

export function typeColor(schema: GraphSchema, kind: "node" | "edge", type: string): string {
  const ui = uiFor(schema, kind, type);
  if (ui?.color && isHexColor(ui.color)) {
    return ui.color.trim();
  }
  return hashColor(type);
}

export function nodeColor(schema: GraphSchema, node: GraphNodeRecord): string {
  const ui = uiFor(schema, "node", node.type);
  if (!ui?.color) {
    return typeColor(schema, "node", node.type);
  }
  const token = ui.color.trim();
  if (isHexColor(token)) {
    return token;
  }
  if (token in node.properties || token in (schema.nodes[node.type]?.properties ?? {})) {
    return colorForValue(node.properties[token]);
  }
  return isHexColor(token) ? token : hashColor(token);
}

export function nodeShape(schema: GraphSchema, node: GraphNodeRecord): string {
  const icon = uiFor(schema, "node", node.type)?.icon?.trim().toLowerCase();
  if (!icon) {
    return "dot";
  }
  return ICON_SHAPES[icon] ?? "dot";
}

export function nodeTooltip(schema: GraphSchema, node: GraphNodeRecord): string {
  const lines = [`${node.type} · ${node.id.slice(0, 8)}`, nodeLabel(schema, node)];
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  if (node.tags && node.tags.length > 0) {
    lines.push(`tags: ${node.tags.join(", ")}`);
  }
  const who = node.meta.updatedBy ?? node.meta.createdBy;
  const at = node.meta.updatedAt ?? node.meta.createdAt;
  if (who || at) {
    lines.push([who, at].filter(Boolean).join(" · "));
  }
  return lines.join("\n");
}

export function edgeTooltip(schema: GraphSchema, edge: GraphEdgeRecord): string {
  const lines = [`${edge.type} · ${edge.id.slice(0, 8)}`];
  for (const [key, value] of Object.entries(edge.properties)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  return lines.join("\n");
}

export function accentBorder(background: string): string {
  return darken(background, 0.18);
}

import type { GraphSchema } from "@collabnode/schema";

export function validEdgeTypes(schema: GraphSchema, fromType: string, toType: string): string[] {
  return Object.entries(schema.edges)
    .filter(([, def]) => def.from.includes(fromType) && def.to.includes(toType))
    .map(([name]) => name);
}

export function humanizeType(type: string): string {
  return type.replaceAll("_", " ").toLowerCase();
}

/** Prefer A→B; if that pair has no types, flip to B→A. */
export function resolveLink(
  schema: GraphSchema,
  fromId: string,
  toId: string,
  fromType: string,
  toType: string,
): { fromId: string; toId: string; types: string[] } {
  const forward = validEdgeTypes(schema, fromType, toType);
  if (forward.length > 0) {
    return { fromId, toId, types: forward };
  }
  // eslint-disable-next-line sonarjs/arguments-order -- the swap is the B→A retry
  const reverse = validEdgeTypes(schema, toType, fromType);
  if (reverse.length > 0) {
    return { fromId: toId, toId: fromId, types: reverse };
  }
  return { fromId, toId, types: [] };
}

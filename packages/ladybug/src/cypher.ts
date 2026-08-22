import type { EntityMeta, GraphOp, PropertyMap } from "@collabnode/graph";

function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function assignments(alias: string, properties: PropertyMap, meta: EntityMeta): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    parts.push(`${alias}.${key} = ${literal(value)}`);
  }
  for (const key of ["createdAt", "createdBy", "updatedAt", "updatedBy"] as const) {
    const value = meta[key];
    if (value !== undefined) {
      parts.push(`${alias}.${key} = ${literal(value)}`);
    }
  }
  return parts.join(", ");
}

function relProps(op: Extract<GraphOp, { kind: "upsertEdge" }>): string {
  const fields: string[] = [`collabId: ${literal(op.id)}`];
  for (const [key, value] of Object.entries(op.properties)) {
    fields.push(`${key}: ${literal(value)}`);
  }
  for (const key of ["createdAt", "createdBy", "updatedAt", "updatedBy"] as const) {
    const value = op.meta[key];
    if (value !== undefined) {
      fields.push(`${key}: ${literal(value)}`);
    }
  }
  return fields.join(", ");
}

export function opToCypher(op: GraphOp): string[] {
  switch (op.kind) {
    case "upsertNode": {
      const sets = assignments("n", op.properties, op.meta);
      const merge = `MERGE (n:${op.type} {id: ${literal(op.id)}})`;
      return sets ? [`${merge} SET ${sets}`] : [merge];
    }
    case "deleteNode":
      return [`MATCH (n {id: ${literal(op.id)}}) DETACH DELETE n`];
    case "upsertEdge":
      return [
        `MATCH ()-[r {collabId: ${literal(op.id)}}]->() DELETE r`,
        `MATCH (a {id: ${literal(op.from)}}), (b {id: ${literal(op.to)}}) CREATE (a)-[r:${op.type} {${relProps(op)}}]->(b)`,
      ];
    case "deleteEdge":
      return [`MATCH ()-[r {collabId: ${literal(op.id)}}]->() DELETE r`];
    default: {
      const _never: never = op;
      return _never;
    }
  }
}

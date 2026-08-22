import type { GraphEdgeRecord, GraphNodeRecord, QueryResult, QueryRow } from "./ops.js";
import { GraphStoreError } from "./store.js";

const MATCH_NODE = /^MATCH\s+\((\w+):(\w+)\)\s+RETURN\s+\1\s*$/i;
const MATCH_EDGE =
  /^MATCH\s+\((\w+)(?::(\w+))?\)-\[(\w+):(\w+)\]->\((\w+)(?::(\w+))?\)\s+RETURN\s+(.+)$/i;

export function runMinimalQuery(
  cypher: string,
  nodes: Map<string, GraphNodeRecord>,
  edges: Map<string, GraphEdgeRecord>,
): QueryResult {
  const trimmed = cypher.trim().replace(/\s+/g, " ");
  const nodeMatch = MATCH_NODE.exec(trimmed);
  if (nodeMatch) {
    const alias = nodeMatch[1]!;
    const type = nodeMatch[2]!;
    const rows: QueryRow[] = [];
    for (const node of nodes.values()) {
      if (node.type === type) {
        rows.push({ [alias]: node });
      }
    }
    return { columns: [alias], rows };
  }

  const edgeMatch = MATCH_EDGE.exec(trimmed);
  if (edgeMatch) {
    const startAlias = edgeMatch[1]!;
    const startType = edgeMatch[2];
    const relAlias = edgeMatch[3]!;
    const relType = edgeMatch[4]!;
    const endAlias = edgeMatch[5]!;
    const endType = edgeMatch[6];
    const returnList = edgeMatch[7]!.split(",").map((part) => part.trim());
    const rows: QueryRow[] = [];
    for (const edge of edges.values()) {
      if (edge.type !== relType) {
        continue;
      }
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (!from || !to) {
        continue;
      }
      if (startType && from.type !== startType) {
        continue;
      }
      if (endType && to.type !== endType) {
        continue;
      }
      const binding: Record<string, unknown> = {
        [startAlias]: from,
        [relAlias]: edge,
        [endAlias]: to,
      };
      const row: QueryRow = {};
      for (const column of returnList) {
        row[column] = binding[column];
      }
      rows.push(row);
    }
    return { columns: returnList, rows };
  }

  throw new GraphStoreError(
    `in-memory store supports only 'MATCH (n:Type) RETURN n' and 'MATCH (a)-[r:TYPE]->(b) RETURN ...' (got: ${trimmed})`,
  );
}

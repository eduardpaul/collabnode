import type { GraphSchema } from "@collabnode/schema";
import { assertGraphName, assertLabel, sqlString } from "./names.js";

export function schemaToAgeDdl(schema: GraphSchema, graphName?: string): string[] {
  const graph = assertGraphName(graphName ?? schema.config.schemaId);
  const g = sqlString(graph);
  const statements = [
    "CREATE EXTENSION IF NOT EXISTS age",
    "LOAD 'age'",
    'SET search_path = ag_catalog, "$user", public',
    `SELECT create_graph(${g})`,
  ];
  for (const name of Object.keys(schema.nodes)) {
    statements.push(`SELECT create_vlabel(${g}, ${sqlString(assertLabel(name))})`);
  }
  for (const name of Object.keys(schema.edges)) {
    statements.push(`SELECT create_elabel(${g}, ${sqlString(assertLabel(name))})`);
  }
  return statements;
}

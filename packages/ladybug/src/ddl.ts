import type { GraphSchema, PropertyDef } from "@collabnode/schema";

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return `\`${name.replaceAll("`", "``")}\``;
  }
  return name;
}

export function ladybugColumnType(property: PropertyDef): string {
  switch (property.type) {
    case "number":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "string":
    case "datetime":
    case "enum":
    case "json":
    case "text":
    case "map":
    case "array":
      return "STRING";
    default: {
      const _never: never = property.type;
      return _never;
    }
  }
}

function propertyColumns(properties: Record<string, PropertyDef>): string[] {
  const columns = ["id STRING PRIMARY KEY"];
  for (const [name, def] of Object.entries(properties)) {
    columns.push(`${quoteIdent(name)} ${ladybugColumnType(def)}`);
  }
  columns.push("createdAt STRING", "createdBy STRING", "updatedAt STRING", "updatedBy STRING");
  return columns;
}

export function schemaToDdl(schema: GraphSchema): string[] {
  const statements: string[] = [];
  for (const [name, node] of Object.entries(schema.nodes)) {
    const cols = propertyColumns(node.properties).join(", ");
    statements.push(`CREATE NODE TABLE IF NOT EXISTS ${quoteIdent(name)}(${cols})`);
  }
  for (const [name, edge] of Object.entries(schema.edges)) {
    const fromList = edge.from.map(quoteIdent).join("|");
    const toList = edge.to.map(quoteIdent).join("|");
    const extra = Object.entries(edge.properties).map(
      ([propName, def]) => `${quoteIdent(propName)} ${ladybugColumnType(def)}`,
    );
    extra.unshift("collabId STRING");
    extra.push("createdAt STRING", "createdBy STRING", "updatedAt STRING", "updatedBy STRING");
    const relCols = extra.length > 0 ? `, ${extra.join(", ")}` : "";
    statements.push(
      `CREATE REL TABLE IF NOT EXISTS ${quoteIdent(name)}(FROM ${fromList} TO ${toList}${relCols})`,
    );
  }
  return statements;
}

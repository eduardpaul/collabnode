import { parseSchemaDocument, type GraphSchema } from "@collabnode/schema";

export function resolveWebSchema(schema: GraphSchema | string): GraphSchema {
  if (typeof schema !== "string") {
    return schema;
  }
  const trimmed = schema.trimStart();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(schema) as GraphSchema;
    if (!parsed?.schemaHash || !parsed.config?.schemaId) {
      throw new Error(
        "@collabnode/web connect(): JSON schema is missing schemaHash or config.schemaId",
      );
    }
    return parsed;
  }
  return parseSchemaDocument(schema);
}

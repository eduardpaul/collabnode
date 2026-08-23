import { describe, expect, it } from "vitest";
import { parseSchemaDocument, nodeTypeToJsonSchema, schemaToJsonSchema } from "../src/index.ts";

const yaml = `
name: AgentTestSchema
version: 1
config:
  schemaId: agent-test
  idStrategy: uuid
nodes:
  Task:
    description: "Actionable engineering task with 6-axis estimation"
    properties:
      title:
        type: string
        required: true
        description: "Task summary"
      complexity:
        type: number
        integer: true
        min: 0
        max: 5
        default: 2
        description: "Technical complexity score"
      status:
        type: enum
        values: [todo, doing, done]
        default: todo
      tags:
        type: array
  Epic:
    description: "Business epic grouping features"
    properties:
      title:
        type: string
        required: true
`;

describe("JSON Schema Generator", () => {
  it("converts NodeTypeDef into standard JSON Schema object", () => {
    const schema = parseSchemaDocument(yaml);
    const taskJsonSchema = nodeTypeToJsonSchema(schema, "Task");

    expect(taskJsonSchema.type).toBe("object");
    expect(taskJsonSchema.title).toBe("Task");
    expect(taskJsonSchema.description).toBe("Actionable engineering task with 6-axis estimation");
    expect(taskJsonSchema.required).toEqual(["title"]);
    expect(taskJsonSchema.properties.title).toEqual({
      type: "string",
      description: "Task summary",
    });
    expect(taskJsonSchema.properties.complexity).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 5,
      default: 2,
      description: "Technical complexity score",
    });
    expect(taskJsonSchema.properties.status.enum).toEqual(["todo", "doing", "done"]);
    expect(taskJsonSchema.properties.tags.type).toBe("array");
  });

  it("converts all node types in a schema", () => {
    const schema = parseSchemaDocument(yaml);
    const allSchemas = schemaToJsonSchema(schema);

    expect(allSchemas.Task).toBeDefined();
    expect(allSchemas.Epic).toBeDefined();
    expect(allSchemas.Epic.properties.title.type).toBe("string");
  });
});

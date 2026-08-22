import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { propertiesZod, propertyZod } from "../src/property-zod.ts";

const schema = parseSchemaDocument(`
name: TaskBoard
version: 1
config:
  schemaId: task-board
nodes:
  Task:
    properties:
      title:
        type: string
        required: true
        maxLength: 8
      status:
        type: enum
        values: [todo, doing, done]
        default: todo
      estimate:
        type: number
      complexity:
        type: number
        integer: true
        min: 0
        max: 5
      effortWeight:
        type: number
        derived: "complexity * (1 + 1)"
`);

describe("propertyZod", () => {
  it("requires title, enums status, and optionals estimate", () => {
    const title = propertyZod(schema.nodes.Task!.properties.title!);
    expect(title.parse("Ship")).toBe("Ship");
    expect(() => title.parse(1)).toThrow();

    const status = propertyZod(schema.nodes.Task!.properties.status!);
    expect(status.parse("doing")).toBe("doing");
    expect(status.parse(undefined)).toBeUndefined();
    expect(() => status.parse("nope")).toThrow();

    const estimate = propertyZod(schema.nodes.Task!.properties.estimate!);
    expect(estimate.parse(3)).toBe(3);
    expect(estimate.parse(undefined)).toBeUndefined();
    expect(estimate.parse(null)).toBeNull();

    expect(status.parse(null)).toBeNull();
    expect(() => title.parse(null)).toThrow();
  });

  it("mirrors integer, min/max, and string maxLength", () => {
    const title = propertyZod(schema.nodes.Task!.properties.title!);
    expect(() => title.parse("too-long-title")).toThrow();

    const complexity = propertyZod(schema.nodes.Task!.properties.complexity!);
    expect(complexity.parse(0)).toBe(0);
    expect(complexity.parse(5)).toBe(5);
    expect(complexity.parse(undefined)).toBeUndefined();
    expect(() => complexity.parse(3.5)).toThrow();
    expect(() => complexity.parse(-1)).toThrow();
    expect(() => complexity.parse(6)).toThrow();
  });

  it("documents datetime fields as ISO-8601", () => {
    const when = propertyZod({ type: "datetime", required: true });
    expect(when.parse("2024-01-01T00:00:00.000Z")).toBe("2024-01-01T00:00:00.000Z");
  });

  it("omits derived properties from writable upsert shapes", () => {
    const shape = propertiesZod(schema.nodes.Task!.properties);
    expect(Object.keys(shape.shape)).toEqual(["title", "status", "estimate", "complexity"]);
    const parsed = shape.parse({ title: "ok", complexity: 3, effortWeight: 99 }) as Record<
      string,
      unknown
    >;
    expect(parsed).not.toHaveProperty("effortWeight");
  });
});

import { describe, expect, it } from "vitest";
import { parseSchemaDocument } from "../src/index.ts";
import { partitionNodeProperties } from "../src/collab.ts";

const schema = parseSchemaDocument(`
name: Notes
version: 1
config:
  schemaId: notes
nodes:
  Note:
    properties:
      title:
        type: string
        required: true
      body:
        type: text
        required: true
`);

describe("partitionNodeProperties text", () => {
  it("keeps a string body", () => {
    const split = partitionNodeProperties(schema.nodes.Note!, {
      title: "A",
      body: "## Hello",
    });
    expect(split.scalars).toEqual({ title: "A" });
    expect(split.crdt).toEqual({ body: "## Hello" });
  });

  it("joins array / text-part bodies from tool calls", () => {
    const split = partitionNodeProperties(schema.nodes.Note!, {
      title: "A",
      body: ["## Hello", { text: "world" }],
    });
    expect(split.crdt.body).toBe("## Hello\nworld");
  });
});

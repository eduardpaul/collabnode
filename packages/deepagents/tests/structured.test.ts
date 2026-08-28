import { describe, expect, it, vi } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import {
  bindAgentTools,
  invokeStructured,
  sanitizeJsonSchema,
  toBindableTools,
  toolParametersJsonSchema,
} from "../src/index.js";
import { createTestSession, workspaceType } from "./workspace.js";

describe("toolParametersJsonSchema", () => {
  it("converts a Zod object instead of passing its internals off as a schema", () => {
    const schema = toolParametersJsonSchema(
      z.object({ title: z.string(), count: z.number().optional() }),
    );

    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as object)).toEqual(["title", "count"]);
    expect(schema.required).toEqual(["title"]);
    // The regression this pins: a Zod v4 object has its own `type: "object"`.
    expect(schema).not.toHaveProperty("def");
    expect(schema).not.toHaveProperty("_zod");
  });

  it("passes JSON Schema through, stripping what the providers reject", () => {
    const schema = toolParametersJsonSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "urn:x",
      type: "object",
      propertyNames: { pattern: "^x" },
      properties: { kind: { const: "task" } },
    });

    expect(schema.$schema).toBeUndefined();
    expect(schema.$id).toBeUndefined();
    expect(schema.propertyNames).toBeUndefined();
    expect((schema.properties as Record<string, { enum?: unknown[] }>).kind?.enum).toEqual([
      "task",
    ]);
  });

  it("falls back to an empty object schema for something that is neither", () => {
    expect(toolParametersJsonSchema("nonsense")).toEqual({ type: "object", properties: {} });
    expect(toolParametersJsonSchema(undefined)).toEqual({ type: "object", properties: {} });
  });
});

describe("sanitizeJsonSchema", () => {
  it("inlines $defs and drops the indirection Gemini rejects", () => {
    const clean = sanitizeJsonSchema({
      type: "object",
      $defs: { Point: { type: "object", properties: { x: { type: "number" } } } },
      properties: {
        origin: { $ref: "#/$defs/Point", description: "Where it starts." },
        path: { type: "array", items: { $ref: "#/$defs/Point" } },
      },
    }) as Record<string, any>;

    expect(clean.$defs).toBeUndefined();
    expect(clean.properties.origin.$ref).toBeUndefined();
    expect(clean.properties.origin.properties.x).toEqual({ type: "number" });
    // The ref site's own keywords survive the inlining.
    expect(clean.properties.origin.description).toBe("Where it starts.");
    expect(clean.properties.path.items.properties.x).toEqual({ type: "number" });
  });

  it("terminates on a self-referential $ref", () => {
    const clean = sanitizeJsonSchema({
      type: "object",
      $defs: {
        Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } },
      },
      properties: { root: { $ref: "#/$defs/Node" } },
    }) as Record<string, any>;

    expect(clean.properties.root.properties.child.$ref).toBeUndefined();
    expect(clean.properties.root.properties.child.type).toBe("object");
    expect(JSON.stringify(clean)).not.toContain("$ref");
  });

  it("leaves the input untouched", () => {
    const input = { type: "object", properties: { a: { const: 1 } }, $schema: "x" };
    sanitizeJsonSchema(input);
    expect(input.$schema).toBe("x");
    expect(input.properties.a).toEqual({ const: 1 });
  });
});

describe("toBindableTools", () => {
  it("gives a Zod-schema tool real parameters", () => {
    const tool = {
      name: "upsert",
      description: "Write a thing",
      schema: z.object({ title: z.string() }),
    } as unknown as StructuredToolInterface;

    const [bound] = toBindableTools([tool]) as Array<{
      function: { name: string; parameters: Record<string, unknown> };
    }>;

    expect(bound?.function.name).toBe("upsert");
    expect(Object.keys(bound?.function.parameters.properties as object)).toEqual(["title"]);
    expect(bound?.function.parameters).not.toHaveProperty("def");
  });

  it("hands an unconvertible tool back untouched rather than sending garbage", () => {
    const tool = { name: "odd", description: "", schema: 42 } as unknown as StructuredToolInterface;
    expect(toBindableTools([tool])[0]).toBe(tool);
  });
});

describe("bindAgentTools", () => {
  it("produces tools whose schemas are JSON Schema, not Zod internals", async () => {
    const session = await createTestSession();
    const tools = bindAgentTools({
      session,
      schema: workspaceType.schema,
      toolsPolicy: workspaceType.tools,
      agentDef: workspaceType.tools?.agents?.[0],
    });

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const schema = tool.schema as unknown as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeTypeOf("object");
      expect(schema).not.toHaveProperty("_zod");
      expect(schema).not.toHaveProperty("def");
    }

    const upsert = tools.find((t) => t.name === "upsert_node_Goal");
    const properties = (upsert?.schema as unknown as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties).length).toBeGreaterThan(0);
  });
});

describe("invokeStructured", () => {
  const answer = z.object({ ok: z.boolean() });
  const tool = { name: "graph_get", invoke: async () => "{}" } as unknown as StructuredToolInterface;

  it("still answers when the tool loop fails mid-flight", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = {
      bindTools: () => ({
        invoke: async () => {
          throw new Error("provider rejected the tool schema");
        },
      }),
      withStructuredOutput: () => ({ invoke: async () => ({ ok: true }) }),
    } as unknown as BaseChatModel;

    await expect(invokeStructured(model, answer, "plan it", "answer", { tools: [tool] })).resolves
      .toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("carries what the tools returned into the structured call", async () => {
    let body = "";
    const model = {
      bindTools: () => ({
        invoke: async () => ({
          tool_calls: [{ name: "graph_get", args: {}, id: "c1" }],
          content: "",
        }),
      }),
      withStructuredOutput: () => ({
        invoke: async (messages: Array<{ content: string }>) => {
          body = messages[messages.length - 1]!.content;
          return { ok: true };
        },
      }),
    } as unknown as BaseChatModel;

    const events: string[] = [];
    await invokeStructured(model, answer, "plan it", "answer", {
      tools: [tool],
      maxToolRounds: 1,
      onToolEvent: (event) => events.push(event.name),
    });

    expect(events).toEqual(["graph_get"]);
    expect(body).toContain("## Tool findings");
    expect(body).toContain("graph_get");
  });
});

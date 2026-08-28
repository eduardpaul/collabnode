import { describe, expect, it } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import {
  bindAgentTools,
  invokeStructured,
  sanitizeJsonSchema,
  toBindableTools,
  toProviderJsonSchema,
  toolParametersJsonSchema,
} from "../src/index.js";
import { createTestSession, workspaceType } from "./workspace.js";

describe("toProviderJsonSchema", () => {
  it("converts a Zod object instead of passing its internals off as a schema", () => {
    const schema = toProviderJsonSchema(
      z.object({ title: z.string(), count: z.number().optional() }),
    );

    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as object)).toEqual(["title", "count"]);
    expect(schema.required).toEqual(["title"]);
    expect(schema.additionalProperties).toBe(false);
    // The regression this pins: a Zod v4 object has its own `type: "object"`.
    expect(schema).not.toHaveProperty("def");
    expect(schema).not.toHaveProperty("_zod");
  });

  it("passes JSON Schema through, stripping what the providers reject", () => {
    const schema = toProviderJsonSchema({
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

  it("inlines $defs on a discriminated-union-shaped document instead of collapsing it", () => {
    const schema = toProviderJsonSchema({
      $defs: {
        Epic: { type: "object", properties: { type: { const: "Epic" }, title: { type: "string" } } },
        Feature: {
          type: "object",
          properties: { type: { const: "Feature" }, title: { type: "string" } },
        },
      },
      oneOf: [{ $ref: "#/$defs/Epic" }, { $ref: "#/$defs/Feature" }],
    });

    expect(schema.$defs).toBeUndefined();
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(schema.oneOf).toHaveLength(2);
    expect(schema).not.toEqual({ type: "object", properties: {} });
  });

  it("falls back to an empty object schema for something that is neither", () => {
    expect(toProviderJsonSchema("nonsense")).toEqual({ type: "object", properties: {} });
    expect(toProviderJsonSchema(undefined)).toEqual({ type: "object", properties: {} });
  });

  it("is the same function as the toolParametersJsonSchema alias", () => {
    expect(toolParametersJsonSchema).toBe(toProviderJsonSchema);
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

  it("sends an empty object schema rather than an unconvertible value", () => {
    const tool = { name: "odd", description: "", schema: 42 } as unknown as StructuredToolInterface;
    const [bound] = toBindableTools([tool]) as Array<{
      function: { parameters: Record<string, unknown> };
    }>;
    expect(bound?.function.parameters).toEqual({ type: "object", properties: {} });
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
    const schema = upsert?.schema as unknown as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
    // `toolJsonSchema` restores YAML `required: true` on upserts.
    expect(schema.required).toContain("title");
  });
});

describe("invokeStructured", () => {
  const answer = z.object({ ok: z.boolean() });

  it("is a single shot: no bindTools, sanitized JSON Schema, then parse", async () => {
    let seen: { schema: unknown; config: unknown } | undefined;
    const model = {
      bindTools: () => {
        throw new Error("structured output must not bind tools");
      },
      withStructuredOutput: (schema: unknown, config: unknown) => {
        seen = { schema, config };
        return { invoke: async () => ({ ok: true }) };
      },
    } as unknown as BaseChatModel;

    await expect(invokeStructured(model, answer, "plan it", "answer")).resolves.toEqual({
      ok: true,
    });
    expect(seen?.config).toMatchObject({ name: "answer", strict: true });
    const payload = seen?.schema as Record<string, unknown>;
    expect(payload).not.toHaveProperty("_zod");
    expect(payload).not.toHaveProperty("def");
    expect(JSON.stringify(payload)).not.toContain("$ref");
    expect(payload.type).toBe("object");
  });

  it("parses the provider payload through the Zod schema", async () => {
    const model = {
      withStructuredOutput: () => ({ invoke: async () => ({ ok: "yes" }) }),
    } as unknown as BaseChatModel;

    await expect(invokeStructured(model, answer, "plan it", "answer")).rejects.toThrow();
  });

  it("forwards the system prompt as a SystemMessage", async () => {
    let input: unknown;
    const model = {
      withStructuredOutput: () => ({
        invoke: async (messages: unknown) => {
          input = messages;
          return { ok: true };
        },
      }),
    } as unknown as BaseChatModel;

    await invokeStructured(model, answer, "make epics", "manager_plan", {
      system: "You are the manager.",
    });

    const messages = input as Array<{ constructor: { name: string }; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("You are the manager.");
    expect(messages[1]?.content).toBe("make epics");
  });
});

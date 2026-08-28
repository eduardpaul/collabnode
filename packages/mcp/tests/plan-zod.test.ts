import {
  parseSchemaDocument,
  type GraphSchemaLiteral,
  type GraphTypes,
  type NodeInput,
  type StrictInput,
} from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { nodeZod, planEnvelope, planZod, type GraphPlan } from "../src/plan-zod.ts";

const schema = parseSchemaDocument(`
name: Planner
version: 1
config:
  schemaId: planner
nodes:
  Epic:
    description: A business initiative.
    guidelines:
      - An Epic owns its Features through HAS_FEATURE, never through a title.
    properties:
      title:
        type: string
        required: true
      priority:
        type: enum
        values: [low, medium, high]
        default: medium
      dirty:
        type: boolean
        default: false
  Feature:
    properties:
      title:
        type: string
        required: true
edges:
  HAS_FEATURE:
    description: An Epic owns this Feature.
    from: [Epic]
    to: [Feature]
    directed: true
    properties:
      rank:
        type: number
`);

const bounded = parseSchemaDocument(`
name: Bounded
version: 1
config:
  schemaId: bounded
nodes:
  Task:
    properties:
      title:
        type: string
        required: true
        maxLength: 40
      points:
        type: number
        required: true
        integer: true
        min: 1
        max: 21
        description: Story points.
`);

describe("nodeZod", () => {
  it("builds the node's properties from the schema, enums included", () => {
    const epic = nodeZod(schema, "Epic");
    expect(Object.keys(epic.shape).sort()).toEqual(["dirty", "priority", "title"]);
    expect(epic.parse({ title: "Ship it", priority: "high" }).priority).toBe("high");
    expect(() => epic.parse({ title: "Ship it", priority: "urgent" })).toThrow();
    expect(() => epic.parse({ priority: "high" })).toThrow();
  });

  it("carries the type's description and guidelines into the schema", () => {
    const description = nodeZod(schema, "Epic").description ?? "";
    expect(description).toContain("A business initiative.");
    expect(description).toContain("HAS_FEATURE");
    // The whole point of a plan: structure is edges, never a property.
    expect(description).toContain("edges");
  });

  it("omits what the caller writes itself", () => {
    const epic = nodeZod(schema, "Epic", { omit: ["dirty"] });
    expect(Object.keys(epic.shape).sort()).toEqual(["priority", "title"]);
  });

  it("keeps every key required in strict mode, nullable in place of absent", () => {
    const strict = nodeZod(schema, "Epic", { mode: "strict" });
    const json = z.toJSONSchema(strict, { io: "input" }) as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    // OpenAI/Azure strict json_schema rejects a schema whose `required` does not
    // list every property, which is what an `.optional()` field produces.
    expect(json.required?.sort()).toEqual(["dirty", "priority", "title"]);
    expect(strict.parse({ title: "Ship it", priority: null, dirty: null }).priority).toBeNull();
    expect(() => strict.parse({ title: "Ship it" })).toThrow();
  });

  it("moves bounds into the description in strict mode", () => {
    // OpenAI/Azure strict json_schema rejects `minimum`/`maximum`/`maxLength`
    // outright, so a bound declared in the YAML would take the whole call down.
    const strict = nodeZod(bounded, "Task", { mode: "strict" });
    const json = z.toJSONSchema(strict, { io: "input" }) as {
      properties: Record<string, { minimum?: number; maximum?: number; maxLength?: number; description?: string; type?: string }>;
    };
    const points = json.properties.points!;
    // The declared bounds are gone from the schema (zod's own `.int()` safe-integer
    // range is a separate thing, and providers accept it).
    expect(points.minimum).not.toBe(1);
    expect(points.maximum).not.toBe(21);
    expect(points.type).toBe("integer");
    expect(points.description).toContain("1");
    expect(points.description).toContain("21");
    expect(json.properties.title!.maxLength).toBeUndefined();
    // Out of range costs the one property at write time, not the whole plan at
    // parse time.
    expect(strict.parse({ title: "x", points: 34 }).points).toBe(34);
  });

  it("refuses a type the schema does not have", () => {
    expect(() => nodeZod(schema, "Nope")).toThrow(/Unknown node type/);
  });
});

describe("planZod", () => {
  it("takes nodes with refs and edges that point at them", () => {
    const plan = planZod(schema, { mode: "strict" });
    const parsed = plan.parse({
      nodes: [
        { type: "Epic", ref: "epic-1", id: null, properties: { title: "Onboarding", priority: "high", dirty: null } },
        { type: "Feature", ref: "feat-1", id: null, properties: { title: "Sign-up" } },
      ],
      edges: [{ type: "HAS_FEATURE", from: "epic-1", to: "feat-1", properties: { rank: 1 } }],
    });
    expect(parsed.edges[0]).toMatchObject({ from: "epic-1", to: "feat-1" });
  });

  it("updates an existing node by id and creates one without", () => {
    const plan = planZod(schema, { mode: "strict" });
    const parsed = plan.parse({
      nodes: [
        { type: "Epic", ref: "e", id: "epic-abc123", properties: { title: "Renamed", priority: null, dirty: null } },
        { type: "Feature", ref: "f", id: null, properties: { title: "New one" } },
      ],
      edges: [{ type: "HAS_FEATURE", from: "e", to: "f", properties: { rank: null } }],
    });
    expect(parsed.nodes[0]!.id).toBe("epic-abc123");
    expect(parsed.nodes[1]!.id).toBeNull();
  });

  it("has nowhere to put a parent title", () => {
    const plan = planZod(schema);
    const parsed = plan.parse({
      nodes: [{ type: "Feature", ref: "feat-1", properties: { title: "Sign-up", epicTitle: "Onboarding" } }],
      edges: [],
    });
    expect(parsed.nodes[0]!.properties).not.toHaveProperty("epicTitle");
  });

  it("rejects a node type or edge type outside the plan's scope", () => {
    const plan = planZod(schema, { nodeTypes: ["Feature"], edgeTypes: [] });
    expect(() =>
      plan.parse({ nodes: [{ type: "Epic", ref: "e", properties: { title: "x" } }], edges: [] }),
    ).toThrow();
  });
});

/**
 * The compile-time and runtime derivations of the same YAML, checked against
 * each other.
 *
 * `nodeZod` builds a validator from a `PropertyDef`; `NodeInput`/`StrictInput`
 * build a type from the same one. Nothing forces them to agree — they are
 * written in different files, in different languages, by different rules — so
 * this is where a value the types call legal has to survive the validator that
 * the model's answer meets. A drift between the two would otherwise show up as
 * a plan that typechecks and then fails to parse at runtime.
 */
describe("the types and the validator agree", () => {
  // Only ever used as a type, via `typeof`.
  const _literal = {
    nodes: {
      Epic: {
        properties: {
          title: { type: "string", required: true },
          priority: { type: "enum", values: ["low", "medium", "high"], default: "medium" },
          dirty: { type: "boolean", default: false },
        },
      },
      Feature: { properties: { title: { type: "string", required: true } } },
    },
    edges: {
      HAS_FEATURE: {
        from: ["Epic"],
        to: ["Feature"],
        directed: true,
        properties: { rank: { type: "number" } },
      },
    },
  } as const satisfies GraphSchemaLiteral;

  it("accepts a node the write type calls valid", () => {
    const properties: NodeInput<typeof _literal, "Epic"> = { title: "Onboarding", priority: "high" };
    expect(() => nodeZod(schema, "Epic").parse(properties)).not.toThrow();
  });

  it("accepts, under strict mode, what the strict type describes", () => {
    const properties: StrictInput<typeof _literal, "Epic"> = {
      title: "Onboarding",
      priority: null,
      dirty: null,
    };
    expect(() => nodeZod(schema, "Epic", { mode: "strict" }).parse(properties)).not.toThrow();
  });

  it("round-trips a whole plan typed by GraphPlan", () => {
    type Planner = GraphTypes<typeof _literal>;
    const plan: GraphPlan<Planner> = {
      nodes: [
        { type: "Epic", ref: "e1", properties: { title: "Onboarding", priority: "high" } },
        { type: "Feature", ref: "f1", properties: { title: "Sign-up" } },
      ],
      edges: [{ type: "HAS_FEATURE", from: "e1", to: "f1", properties: { rank: 1 } }],
    };
    const parsed = planZod<Planner>(schema).parse(plan);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges[0]!.from).toBe("e1");
  });

  it("omits the same properties from both halves", () => {
    // `dirty` is the runtime's to set. `omit` drops it from the validator; the
    // caller's own type should be built to match.
    const shape = nodeZod(schema, "Epic", { omit: ["dirty"] });
    expect(Object.keys((shape as z.ZodObject<Record<string, z.ZodTypeAny>>).shape)).not.toContain(
      "dirty",
    );
  });

  it("keeps the plan intact inside an envelope, and asks in schema order", () => {
    type Planner = GraphTypes<typeof _literal>;
    const answer = planEnvelope(planZod<Planner>(schema), {
      before: { review: z.string() },
      after: { agrees: z.boolean() },
    });

    const parsed = answer.parse({
      review: "added the onboarding epic",
      nodes: [{ type: "Epic", ref: "e1", properties: { title: "Onboarding", priority: "high" } }],
      edges: [],
      agrees: true,
    });
    // The plan half still parses as a plan, and the extra keys are typed.
    expect(parsed.nodes[0]!.properties.title).toBe("Onboarding");
    expect(parsed.review).toBe("added the onboarding epic");
    expect(parsed.agrees).toBe(true);

    // Key order is prompt order: a model fills a structured answer top to
    // bottom, so `before` has to precede the plan and `after` follow it.
    const json = z.toJSONSchema(answer, { io: "input" }) as { properties: Record<string, unknown> };
    expect(Object.keys(json.properties)).toEqual(["review", "nodes", "edges", "agrees"]);
  });
});

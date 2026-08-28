import type { GraphSnapshot } from "@collabnode/graph";
import { nodeAccessFrom, parseSchemaDocument, type ViewDef } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { renderView, resolveView } from "../src/index.ts";

const schema = parseSchemaDocument(`
name: PlannerSchema
version: 1
config:
  schemaId: planner
  idStrategy: uuid
nodes:
  Epic:
    properties:
      title: { type: string, required: true }
      priority: { type: string, default: "medium" }
    ui:
      label: "{title}"
  Task:
    properties:
      title: { type: string, required: true }
      points: { type: number, default: 1 }
      dirty: { type: boolean, default: false }
  Secret:
    properties:
      title: { type: string, required: true }
edges:
  HAS_TASK:
    from: [Epic]
    to: [Task]
  MENTIONS:
    from: [Task]
    to: [Secret]
`);

function node(id: string, type: string, properties: Record<string, unknown>) {
  return { id, type, properties, tags: [] as string[] } as GraphSnapshot["nodes"][number];
}

function edge(id: string, type: string, from: string, to: string) {
  return { id, type, from, to, properties: {} } as GraphSnapshot["edges"][number];
}

/**
 * checkout ──HAS_TASK──> t-cart ──MENTIONS──> s-key
 *          └─HAS_TASK──> t-pay (dirty)
 * billing  ──HAS_TASK──> t-invoice
 */
const snapshot: GraphSnapshot = {
  schemaId: "planner",
  schemaHash: schema.schemaHash,
  nodes: [
    node("e-checkout", "Epic", { title: "Checkout", priority: "high" }),
    node("e-billing", "Epic", { title: "Billing", priority: "low" }),
    node("t-cart", "Task", { title: "Cart", points: 3, dirty: false }),
    node("t-pay", "Task", { title: "Pay", points: 5, dirty: true }),
    node("t-invoice", "Task", { title: "Invoice", points: 2, dirty: false }),
    node("s-key", "Secret", { title: "API key" }),
  ],
  edges: [
    edge("x1", "HAS_TASK", "e-checkout", "t-cart"),
    edge("x2", "HAS_TASK", "e-checkout", "t-pay"),
    edge("x3", "HAS_TASK", "e-billing", "t-invoice"),
    edge("x4", "MENTIONS", "t-cart", "s-key"),
  ],
};

const reviewPlan: ViewDef = {
  title: { en: "Review plan", es: "Revisar plan" },
  description: { en: "Epics and their tasks." },
  guidance: { en: ["Points must be Fibonacci."] },
  params: { epic: { type: "string" } },
  select: {
    roots: { types: ["Epic"], where: "params.epic == null || title == params.epic" },
    traverse: { edges: ["HAS_TASK"], direction: "out", depth: 1 },
  },
  fields: { Epic: ["priority"], Task: ["points"] },
};

const ids = (r: { nodes: Array<{ id: string }> }) => r.nodes.map((n) => n.id);

describe("resolveView", () => {
  it("selects every root and its traversal when no parameter is given", () => {
    const resolved = resolveView(snapshot, reviewPlan, {}, { name: "review_plan" });
    expect(ids(resolved)).toEqual([
      "e-checkout",
      "e-billing",
      "t-cart",
      "t-pay",
      "t-invoice",
    ]);
    // Only edges with both endpoints selected; MENTIONS points at an unselected
    // Secret and must not appear.
    expect(resolved.edges.map((e) => e.id)).toEqual(["x1", "x2", "x3"]);
  });

  it("narrows to one root when the parameter is supplied", () => {
    const resolved = resolveView(snapshot, reviewPlan, { epic: "Checkout" });
    expect(ids(resolved)).toEqual(["e-checkout", "t-cart", "t-pay"]);
  });

  it("returns nothing when the parameter matches no root", () => {
    const resolved = resolveView(snapshot, reviewPlan, { epic: "Nonesuch" });
    expect(resolved.nodes).toEqual([]);
    expect(resolved.edges).toEqual([]);
  });

  it("filters traversed nodes with traverse.where", () => {
    const resolved = resolveView(snapshot, {
      select: {
        roots: { types: ["Epic"] },
        traverse: { edges: ["HAS_TASK"], where: "dirty == true" },
      },
    });
    expect(ids(resolved)).toEqual(["e-checkout", "e-billing", "t-pay"]);
  });

  it("honours traversal direction", () => {
    const resolved = resolveView(snapshot, {
      select: {
        roots: { types: ["Task"], where: "title == 'Cart'" },
        traverse: { edges: ["HAS_TASK"], direction: "in", depth: 1 },
      },
    });
    expect(ids(resolved)).toEqual(["e-checkout", "t-cart"]);
  });

  it("pulls in whole types with select.include", () => {
    const resolved = resolveView(snapshot, {
      select: { roots: { types: ["Epic"], where: "title == 'Checkout'" }, include: ["Secret"] },
    });
    expect(ids(resolved)).toEqual(["e-checkout", "s-key"]);
  });

  it("truncates at maxNodes and reports it", () => {
    const resolved = resolveView(snapshot, { select: { roots: {} }, maxNodes: 2 });
    expect(resolved.nodes).toHaveLength(2);
    expect(resolved.truncated).toBe(true);
  });

  it("drops nodes, edges and field projections of types hidden from the role", () => {
    const access = nodeAccessFrom(schema, { hidden: ["Secret"] });
    const resolved = resolveView(
      snapshot,
      {
        select: { roots: { types: ["Task"] }, include: ["Secret"] },
        fields: { Task: ["points"], Secret: ["title"] },
      },
      {},
      { access },
    );
    expect(ids(resolved)).toEqual(["t-cart", "t-pay", "t-invoice"]);
    expect(resolved.edges).toEqual([]);
    expect(resolved.fields).toEqual({ Task: ["points"] });
  });

  it("validates parameters against their declared types", () => {
    expect(() =>
      resolveView(snapshot, { params: { epic: { type: "number" } } }, { epic: "nope" }),
    ).toThrow();
  });

  it("resolves title, description and guidance in the requested language", () => {
    const resolved = resolveView(snapshot, reviewPlan, {}, { language: "es" });
    expect(resolved.title).toBe("Revisar plan");
  });
});

describe("renderView", () => {
  it("renders markdown with the header, the projected fields and nothing else", () => {
    const markdown = renderView(snapshot, reviewPlan, { epic: "Checkout" }, {
      name: "review_plan",
      schema,
    }) as string;

    expect(markdown).toContain("## Review plan");
    expect(markdown).toContain("Epics and their tasks.");
    expect(markdown).toContain("- Points must be Fibonacci.");
    expect(markdown).toContain("**Checkout**");
    expect(markdown).toContain("*priority*: high");
    expect(markdown).toContain("*points*: 3");
    // `dirty` is a Task property the view did not project.
    expect(markdown).not.toContain("dirty");
    // Billing is a different root, excluded by the parameter.
    expect(markdown).not.toContain("Billing");
  });

  it("prints each node's title once, in the heading, even when projected", () => {
    const markdown = renderView(
      snapshot,
      { select: { roots: { types: ["Epic"] } }, fields: { Epic: ["title", "priority"] } },
      {},
      { schema },
    ) as string;
    expect(markdown).toContain("**Checkout**");
    expect(markdown).not.toContain("*title*");
  });

  it("prints only relationships whose endpoints it also printed", () => {
    // t-cart MENTIONS s-key, but no Secret is selected, so the edge must not be
    // rendered pointing at a node the reader cannot see.
    const markdown = renderView(snapshot, {
      select: { roots: { types: ["Task"] } },
    }) as string;
    expect(markdown).not.toContain("MENTIONS");
  });

  it("says so plainly when nothing matches", () => {
    const markdown = renderView(snapshot, reviewPlan, { epic: "Nonesuch" }) as string;
    expect(markdown).toContain("Nothing matches this view");
  });

  it("returns the resolved view itself in json format", () => {
    const result = renderView(snapshot, { ...reviewPlan, format: "json" }, {});
    expect(typeof result).toBe("object");
    expect((result as { nodes: unknown[] }).nodes.length).toBe(5);
  });
});

import { describe, expect, it } from "vitest";
import {
  edgesOfType,
  findOfType,
  nodeOfType,
  nodesOfType,
  nodesOfTypes,
  ofType,
  singletonOfType,
} from "../src/select.ts";
import type { GraphSnapshot } from "../src/ops.ts";

const snapshot: GraphSnapshot = {
  schemaId: "s",
  schemaHash: "h",
  nodes: [
    { id: "e1", type: "Epic", properties: { title: "Onboarding" }, meta: {} },
    { id: "f1", type: "Feature", properties: { title: "Sign-up" }, meta: {} },
    { id: "f2", type: "Feature", properties: { title: "Sign-in" }, meta: {} },
    { id: "s1", type: "BoardState", properties: { status: "planning" }, meta: {} },
  ],
  edges: [
    { id: "x1", type: "HAS_FEATURE", from: "e1", to: "f1", properties: {}, meta: {} },
    { id: "x2", type: "HAS_FEATURE", from: "e1", to: "f2", properties: {}, meta: {} },
    { id: "x3", type: "BLOCKS", from: "f1", to: "f2", properties: {}, meta: {} },
  ],
};

describe("ofType", () => {
  it("keeps only the members of that type", () => {
    expect(ofType(snapshot.nodes, "Feature").map((n) => n.id)).toEqual(["f1", "f2"]);
  });

  it("returns an empty array for a type nothing has", () => {
    expect(ofType(snapshot.nodes, "Risk")).toEqual([]);
  });

  it("works on anything discriminated on `type`, not just graph records", () => {
    const plan = [
      { type: "Epic", ref: "a" },
      { type: "Task", ref: "b" },
      { type: "Task", ref: "c" },
    ];
    expect(ofType(plan, "Task").map((entry) => entry.ref)).toEqual(["b", "c"]);
  });
});

describe("findOfType", () => {
  it("returns the first member of that type", () => {
    expect(findOfType(snapshot.nodes, "Feature")?.id).toBe("f1");
  });

  it("applies the predicate only to members of that type", () => {
    const found = findOfType(snapshot.nodes, "Feature", (n) => n.properties.title === "Sign-in");
    expect(found?.id).toBe("f2");
  });

  it("is undefined when nothing matches", () => {
    expect(findOfType(snapshot.nodes, "Feature", () => false)).toBeUndefined();
  });
});

describe("nodesOfType / nodesOfTypes", () => {
  it("selects by one type", () => {
    expect(nodesOfType(snapshot, "Feature").map((n) => n.id)).toEqual(["f1", "f2"]);
  });

  it("selects by several types, keeping snapshot order", () => {
    expect(nodesOfTypes(snapshot, ["Epic", "Feature"]).map((n) => n.id)).toEqual(["e1", "f1", "f2"]);
  });
});

describe("nodeOfType", () => {
  it("finds a node by id when the type matches", () => {
    expect(nodeOfType(snapshot, "Feature", "f2")?.properties.title).toBe("Sign-in");
  });

  it("returns undefined when the id names a node of another type", () => {
    // The point of asking for a type: a bare `find` by id would hand back the
    // Epic, and the caller would read it as if it were a Feature.
    expect(nodeOfType(snapshot, "Feature", "e1")).toBeUndefined();
  });

  it("returns undefined for a missing or absent id", () => {
    expect(nodeOfType(snapshot, "Feature", "nope")).toBeUndefined();
    expect(nodeOfType(snapshot, "Feature", undefined)).toBeUndefined();
    expect(nodeOfType(snapshot, "Feature", null)).toBeUndefined();
  });
});

describe("singletonOfType", () => {
  it("returns the one node of a singleton type", () => {
    expect(singletonOfType(snapshot, "BoardState")?.properties.status).toBe("planning");
  });

  it("is undefined before the singleton exists", () => {
    expect(singletonOfType({ ...snapshot, nodes: [] }, "BoardState")).toBeUndefined();
  });
});

describe("edgesOfType", () => {
  it("selects edges by type", () => {
    expect(edgesOfType(snapshot, "HAS_FEATURE").map((e) => e.id)).toEqual(["x1", "x2"]);
    expect(edgesOfType(snapshot, "BLOCKS").map((e) => e.id)).toEqual(["x3"]);
  });
});

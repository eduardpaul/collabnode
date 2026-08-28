import type { GraphSnapshot } from "@collabnode/graph";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import {
  changedEntityIds,
  emptyFilters,
  newNodeIds,
  nodeTypeHidden,
  parseVisibleTypes,
  patchFilters,
  planApply,
  projectGraph,
  toggleNodeType,
} from "../src/view/apply.ts";

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
      status:
        type: enum
        values: [todo, doing, done]
    ui:
      label: "{title}"
      color: status
  Person:
    properties:
      name:
        type: string
        required: true
    ui:
      label: "{name}"
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
    directed: true
    ui:
      label: assigned
`);

const empty: GraphSnapshot = { schemaId: "task-board", schemaHash: "x", nodes: [], edges: [] };

const seeded: GraphSnapshot = {
  ...empty,
  nodes: [
    {
      id: "t1",
      type: "Task",
      properties: { title: "Review budget", status: "todo" },
      meta: {},
    },
    { id: "p1", type: "Person", properties: { name: "Ada" }, meta: {} },
  ],
  edges: [
    {
      id: "e1",
      type: "ASSIGNED_TO",
      from: "t1",
      to: "p1",
      properties: {},
      meta: {},
    },
  ],
};

describe("projectGraph", () => {
  it("projects labels, colors, and arrows from the schema", () => {
    const { nodes, edges } = projectGraph(schema, seeded, emptyFilters());
    const task = nodes.find((node) => node.id === "t1");
    const person = nodes.find((node) => node.id === "p1");
    expect(task?.label).toBe("Review budget");
    expect(task?.color.background).toBe("#6ea8fe");
    expect(person?.label).toBe("Ada");
    expect(edges[0]?.label).toBe("assigned");
    expect(edges[0]?.arrows).toBe("to");
    expect(nodes.every((node) => node.hidden === false)).toBe(true);
  });

  it("shows all types when the visible-types attribute is empty or absent", () => {
    const omitted = projectGraph(schema, seeded, emptyFilters());
    const emptyAttr = projectGraph(schema, seeded, {
      ...emptyFilters(),
      visibleNodeTypes: parseVisibleTypes(""),
    });
    expect(omitted.nodes.every((node) => node.hidden === false)).toBe(true);
    expect(emptyAttr.nodes.every((node) => node.hidden === false)).toBe(true);
  });

  it("hides types and search misses without dropping ids from the plan", () => {
    const hidden = projectGraph(schema, seeded, {
      hiddenNodeTypes: new Set(["Person"]),
      hiddenEdgeTypes: new Set(),
      search: "",
    });
    expect(hidden.nodes.find((node) => node.id === "p1")?.hidden).toBe(true);
    expect(hidden.edges[0]?.hidden).toBe(true);

    const search = projectGraph(schema, seeded, {
      hiddenNodeTypes: new Set(),
      hiddenEdgeTypes: new Set(),
      search: "budget",
    });
    expect(search.nodes.find((node) => node.id === "t1")?.hidden).toBe(false);
    expect(search.nodes.find((node) => node.id === "p1")?.hidden).toBe(true);
  });

  it("hides types not listed in visibleNodeTypes", () => {
    const projected = projectGraph(schema, seeded, {
      hiddenNodeTypes: new Set(),
      hiddenEdgeTypes: new Set(),
      search: "",
      visibleNodeTypes: parseVisibleTypes("Task"),
    });
    expect(projected.nodes.find((node) => node.id === "t1")?.hidden).toBe(false);
    expect(projected.nodes.find((node) => node.id === "p1")?.hidden).toBe(true);
    expect(projected.edges[0]?.hidden).toBe(true);
  });

  it("still honors hiddenNodeTypes inside a visible-types preset", () => {
    const projected = projectGraph(schema, seeded, {
      hiddenNodeTypes: new Set(["Task"]),
      hiddenEdgeTypes: new Set(),
      search: "",
      visibleNodeTypes: parseVisibleTypes("Epic,Feature,Task,Note"),
    });
    expect(projected.nodes.find((node) => node.id === "t1")?.hidden).toBe(true);
    expect(projected.nodes.find((node) => node.id === "p1")?.hidden).toBe(true);
  });
});

describe("visibleNodeIds", () => {
  it("shows only the listed nodes, and hides the edges that leave them", () => {
    const { nodes, edges } = projectGraph(schema, seeded, {
      ...emptyFilters(),
      visibleNodeIds: new Set(["t1"]),
    });
    expect(nodes.find((node) => node.id === "t1")?.hidden).toBe(false);
    expect(nodes.find((node) => node.id === "p1")?.hidden).toBe(true);
    expect(edges[0]?.hidden).toBe(true);
  });

  it("does not restrict anything when absent", () => {
    expect(
      projectGraph(schema, seeded, emptyFilters()).nodes.every((n) => n.hidden === false),
    ).toBe(true);
  });

  it("hides everything when the allowlist is present but empty", () => {
    const filters = { ...emptyFilters(), visibleNodeIds: new Set<string>() };
    expect(projectGraph(schema, seeded, filters).nodes.every((n) => n.hidden === true)).toBe(true);
  });

  it("composes with the type filters — a node must satisfy both", () => {
    const { nodes } = projectGraph(schema, seeded, {
      ...emptyFilters(),
      visibleNodeTypes: new Set(["Person"]),
      visibleNodeIds: new Set(["t1"]),
    });
    expect(nodes.every((node) => node.hidden === true)).toBe(true);
  });

  it("survives patchFilters and toggleNodeType", () => {
    const patched = patchFilters(emptyFilters(), { visibleNodeIds: new Set(["t1"]) });
    expect(patched.visibleNodeIds).toEqual(new Set(["t1"]));
    expect(toggleNodeType(patched, "Person").visibleNodeIds).toEqual(new Set(["t1"]));
    expect(patchFilters(patched, { search: "x" }).visibleNodeIds).toEqual(new Set(["t1"]));
  });

  it("keeps an empty allowlist through patchFilters, and clears it on an explicit undefined", () => {
    const empty = patchFilters(emptyFilters(), { visibleNodeIds: new Set<string>() });
    expect(empty.visibleNodeIds).toEqual(new Set());
    expect(patchFilters(empty, { visibleNodeIds: undefined }).visibleNodeIds).toBeUndefined();
  });
});

describe("parseVisibleTypes", () => {
  it("parses a comma-separated visible-types attribute", () => {
    expect([...parseVisibleTypes("Epic,Feature,Task,Note")!].sort()).toEqual([
      "Epic",
      "Feature",
      "Note",
      "Task",
    ]);
    expect([...parseVisibleTypes(" Epic, Feature ,Task ")!].sort()).toEqual([
      "Epic",
      "Feature",
      "Task",
    ]);
  });

  it("treats empty or absent attributes as show-all", () => {
    expect(parseVisibleTypes(null)).toBeUndefined();
    expect(parseVisibleTypes(undefined)).toBeUndefined();
    expect(parseVisibleTypes("")).toBeUndefined();
    expect(parseVisibleTypes("  ,  ")).toBeUndefined();
  });
});

describe("nodeTypeHidden", () => {
  it("hides types outside a non-empty visible set", () => {
    const filters = {
      hiddenNodeTypes: new Set<string>(),
      hiddenEdgeTypes: new Set<string>(),
      search: "",
      visibleNodeTypes: parseVisibleTypes("Epic,Feature,Task,Note"),
    };
    expect(nodeTypeHidden(filters, "Task")).toBe(false);
    expect(nodeTypeHidden(filters, "Person")).toBe(true);
    expect(nodeTypeHidden({ ...filters, visibleNodeTypes: undefined }, "Person")).toBe(false);
  });
});

describe("patchFilters", () => {
  it("re-applying visibleNodeTypes un-hides allow-listed chip-offs", () => {
    const layer = new Set(["Epic", "Feature", "Task", "Note"]);
    const chipped = toggleNodeType(patchFilters(emptyFilters(), { visibleNodeTypes: layer }), "Task");
    expect(nodeTypeHidden(chipped, "Task")).toBe(true);
    const reapplied = patchFilters(chipped, { visibleNodeTypes: layer });
    expect(nodeTypeHidden(reapplied, "Task")).toBe(false);
    expect(nodeTypeHidden(reapplied, "Person")).toBe(true);
  });

  it("treats emptyFilters() as a full reset", () => {
    const dirty: ReturnType<typeof emptyFilters> = {
      hiddenNodeTypes: new Set(["Task"]),
      hiddenEdgeTypes: new Set(["ASSIGNED_TO"]),
      search: "budget",
      visibleNodeTypes: new Set(["Task"]),
    };
    const reset = patchFilters(dirty, emptyFilters());
    expect(reset.search).toBe("");
    expect(reset.hiddenNodeTypes.size).toBe(0);
    expect(reset.hiddenEdgeTypes.size).toBe(0);
    expect(nodeTypeHidden(reset, "Person")).toBe(false);
    expect(reset.visibleNodeTypes === undefined || reset.visibleNodeTypes.size === 0).toBe(true);
  });

  it("keeps omitted fields when patching a single key", () => {
    const current = patchFilters(emptyFilters(), {
      visibleNodeTypes: new Set(["Task"]),
      search: "budget",
    });
    const next = patchFilters(current, { search: "epic" });
    expect(next.search).toBe("epic");
    expect([...next.visibleNodeTypes!]).toEqual(["Task"]);
  });
});

describe("toggleNodeType", () => {
  it("hides then shows a type when there is no preset", () => {
    const hidden = toggleNodeType(emptyFilters(), "Task");
    expect(nodeTypeHidden(hidden, "Task")).toBe(true);
    expect(nodeTypeHidden(toggleNodeType(hidden, "Task"), "Task")).toBe(false);
  });

  it("reveals a type outside visible-types=Task", () => {
    const preset = patchFilters(emptyFilters(), { visibleNodeTypes: new Set(["Task"]) });
    expect(nodeTypeHidden(preset, "Person")).toBe(true);
    const revealed = toggleNodeType(preset, "Person");
    expect(nodeTypeHidden(revealed, "Person")).toBe(false);
    expect(nodeTypeHidden(revealed, "Task")).toBe(false);
    expect(revealed.visibleNodeTypes?.has("Person")).toBe(true);
  });

  it("hides a type that is in the preset", () => {
    const preset = patchFilters(emptyFilters(), { visibleNodeTypes: new Set(["Task"]) });
    const hidden = toggleNodeType(preset, "Task");
    expect(nodeTypeHidden(hidden, "Task")).toBe(true);
    expect(hidden.visibleNodeTypes?.has("Task")).toBe(true);
    expect(hidden.hiddenNodeTypes.has("Task")).toBe(true);
  });

  it("shows a preset type again after hiding it", () => {
    const preset = patchFilters(emptyFilters(), { visibleNodeTypes: new Set(["Task"]) });
    const shown = toggleNodeType(toggleNodeType(preset, "Task"), "Task");
    expect(nodeTypeHidden(shown, "Task")).toBe(false);
  });
});

describe("planApply", () => {
  it("adds, updates, and removes by id instead of replacing the whole set", () => {
    const first = projectGraph(schema, seeded, emptyFilters());
    const initial = planApply(new Set(), new Set(), first);
    expect(initial.nodesAdd.map((node) => node.id).sort()).toEqual(["p1", "t1"]);
    expect(initial.nodesUpdate).toEqual([]);
    expect(initial.nodesRemove).toEqual([]);
    expect(initial.edgesAdd.map((edge) => edge.id)).toEqual(["e1"]);

    const nextSnap: GraphSnapshot = {
      ...seeded,
      nodes: [
        {
          id: "t1",
          type: "Task",
          properties: { title: "Review budget", status: "doing" },
          meta: {},
        },
        { id: "t2", type: "Task", properties: { title: "Ship", status: "todo" }, meta: {} },
      ],
      edges: [],
    };
    const next = projectGraph(schema, nextSnap, emptyFilters());
    const diff = planApply(new Set(["t1", "p1"]), new Set(["e1"]), next);
    expect(diff.nodesAdd.map((node) => node.id)).toEqual(["t2"]);
    expect(diff.nodesUpdate.map((node) => node.id)).toEqual(["t1"]);
    expect(diff.nodesRemove).toEqual(["p1"]);
    expect(diff.edgesAdd).toEqual([]);
    expect(diff.edgesRemove).toEqual(["e1"]);
  });
});

describe("changedEntityIds / newNodeIds", () => {
  it("does not treat the first snapshot as a pulse, then flags live adds and edits", () => {
    expect(changedEntityIds(undefined, seeded)).toEqual([]);
    expect(newNodeIds(undefined, seeded)).toEqual([]);
    const next: GraphSnapshot = {
      ...seeded,
      nodes: [
        {
          id: "t1",
          type: "Task",
          properties: { title: "Review budget", status: "doing" },
          meta: {},
        },
        seeded.nodes[1]!,
        { id: "t2", type: "Task", properties: { title: "Ship", status: "todo" }, meta: {} },
      ],
    };
    expect(newNodeIds(seeded, next)).toEqual(["t2"]);
    expect(changedEntityIds(seeded, next).sort()).toEqual(["t1", "t2"]);
  });
});

import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { colorForValue } from "../src/view/palette.ts";
import { edgeLabel, interpolateLabel, nodeColor, nodeLabel, nodeShape } from "../src/view/style.ts";

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
        default: todo
    ui:
      label: "{title}"
      color: status
      icon: check-square
  Person:
    properties:
      name:
        type: string
        required: true
    ui:
      label: "{name}"
      color: "#c084fc"
  Service:
    properties:
      name:
        type: string
        required: true
      status:
        type: enum
        values: [healthy, degraded, down]
    ui:
      label: "{name} · {status}"
      color: status
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
    directed: true
    ui:
      label: assigned
  BLOCKS:
    from: [Task]
    to: [Task]
    directed: true
`);

describe("nodeLabel", () => {
  it("interpolates ui.label templates", () => {
    expect(
      nodeLabel(schema, {
        id: "t1",
        type: "Task",
        properties: { title: "Review budget", status: "todo" },
        meta: {},
      }),
    ).toBe("Review budget");
    expect(
      nodeLabel(schema, {
        id: "s1",
        type: "Service",
        properties: { name: "Checkout API", status: "degraded" },
        meta: {},
      }),
    ).toBe("Checkout API · degraded");
  });

  it("falls back to title/name then type + short id", () => {
    const bare = parseSchemaDocument(`
name: Bare
version: 1
config:
  schemaId: bare
nodes:
  Note:
    properties:
      body:
        type: string
`);
    expect(
      nodeLabel(bare, { id: "abcdefghijkl", type: "Note", properties: { body: "hello" }, meta: {} }),
    ).toBe("hello");
    expect(nodeLabel(bare, { id: "abcdefghijkl", type: "Note", properties: {}, meta: {} })).toBe(
      "Note abcdefgh",
    );
  });
});

describe("nodeColor", () => {
  it("maps ui.color property values through the palette", () => {
    expect(
      nodeColor(schema, {
        id: "t1",
        type: "Task",
        properties: { title: "A", status: "done" },
        meta: {},
      }),
    ).toBe("#3dd68c");
    expect(
      nodeColor(schema, {
        id: "s1",
        type: "Service",
        properties: { name: "API", status: "down" },
        meta: {},
      }),
    ).toBe("#ff5d73");
  });

  it("uses a hex ui.color for the whole type", () => {
    expect(
      nodeColor(schema, { id: "p1", type: "Person", properties: { name: "Ada" }, meta: {} }),
    ).toBe("#c084fc");
  });
});

describe("colorForValue", () => {
  it("maps later, now, and dropped in addition to todo/doing/done", () => {
    expect(colorForValue("later")).toBe("#6ea8fe");
    expect(colorForValue("now")).toBe("#f5c542");
    expect(colorForValue("dropped")).toBe("#8b95ab");
    expect(colorForValue("done")).toBe("#3dd68c");
  });
});

describe("nodeShape / edgeLabel / interpolateLabel", () => {
  it("maps known icons to vis shapes and humanizes edges", () => {
    expect(
      nodeShape(schema, { id: "t1", type: "Task", properties: { title: "A" }, meta: {} }),
    ).toBe("box");
    expect(
      edgeLabel(schema, {
        id: "e1",
        type: "ASSIGNED_TO",
        from: "t1",
        to: "p1",
        properties: {},
        meta: {},
      }),
    ).toBe("assigned");
    expect(
      edgeLabel(schema, {
        id: "e2",
        type: "BLOCKS",
        from: "t1",
        to: "t2",
        properties: {},
        meta: {},
      }),
    ).toBe("blocks");
    expect(interpolateLabel("{title} · {status}", { title: "Ship", status: "todo" })).toBe(
      "Ship · todo",
    );
  });
});

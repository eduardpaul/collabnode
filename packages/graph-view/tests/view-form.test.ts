import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import {
  defaultsFor,
  fieldWidget,
  fieldsFor,
  fromDatetimeLocal,
  propertiesFromForm,
  tagsFromForm,
  toDatetimeLocal,
} from "../src/view/form.ts";
import { renderInspector } from "../src/view/inspector.ts";

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
      estimate:
        type: number
      urgent:
        type: boolean
        default: false
      due:
        type: datetime
      extra:
        type: json
      complexity:
        type: number
        integer: true
        min: 0
        max: 5
        ui:
          widget: slider
          label: Complexity
      notes:
        type: string
        maxLength: 400
        ui:
          widget: textarea
      body:
        type: string
        maxLength: 4000
      score:
        type: number
        integer: true
        min: 0
        max: 999
      effortWeight:
        type: number
        derived: "complexity * (1 + 1)"
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Task]
    directed: true
    properties:
      since:
        type: datetime
`);

describe("fieldsFor / defaultsFor", () => {
  it("builds fields from the node type and applies defaults", () => {
    const fields = fieldsFor(schema, "node", "Task");
    expect(fields.map((field) => field.name)).toEqual([
      "title",
      "status",
      "estimate",
      "urgent",
      "due",
      "extra",
      "complexity",
      "notes",
      "body",
      "score",
      "effortWeight",
    ]);
    expect(defaultsFor(fields)).toEqual({ status: "todo", urgent: false });
    const complexity = fields.find((field) => field.name === "complexity");
    expect(complexity).toMatchObject({
      integer: true,
      min: 0,
      max: 5,
      widget: "slider",
      label: "Complexity",
    });
  });
});

describe("fieldWidget", () => {
  const fields = Object.fromEntries(fieldsFor(schema, "node", "Task").map((field) => [field.name, field]));

  it("uses a slider for integer min/max with widget slider", () => {
    expect(fieldWidget(fields.complexity!)).toBe("slider");
  });

  it("uses textarea for widget textarea or maxLength > 200", () => {
    expect(fieldWidget(fields.notes!)).toBe("textarea");
    expect(fieldWidget(fields.body!)).toBe("textarea");
    expect(fieldWidget(fields.title!)).toBe("text");
  });

  it("keeps constrained integers as number inputs without widget slider", () => {
    expect(fieldWidget(fields.score!)).toBe("number");
  });

  it("keeps explicit widget text even when maxLength > 200", () => {
    const custom = parseSchemaDocument(`
name: Widgets
version: 1
config:
  schemaId: widgets
nodes:
  Item:
    properties:
      summary:
        type: string
        maxLength: 400
        ui:
          widget: text
      secret:
        type: string
        ui:
          widget: hidden
`);
    const byName = Object.fromEntries(fieldsFor(custom, "node", "Item").map((field) => [field.name, field]));
    expect(fieldWidget(byName.summary!)).toBe("text");
    expect(fieldWidget(byName.secret!)).toBe("hidden");
    const html = renderInspector(custom, undefined, { kind: "create-node", type: "Item" }, true);
    expect(html).toMatch(/<input type="text" name="summary"/);
    expect(html).not.toMatch(/<textarea name="summary"/);
    expect(html).toMatch(/<input type="hidden" name="secret"/);
  });

  it("exposes collab fields as ordinary form fields", () => {
    const notes = parseSchemaDocument(`
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
      votes:
        type: map
`);
    const fields = fieldsFor(notes, "node", "Note");
    expect(fields.map((field) => [field.name, field.type])).toEqual([
      ["title", "string"],
      ["body", "text"],
      ["votes", "map"],
    ]);
    expect(fieldsFor(notes, "node", "Note", { crdt: "omit" }).map((field) => field.name)).toEqual(["title"]);
  });
});

describe("propertiesFromForm", () => {
  const fields = fieldsFor(schema, "node", "Task");

  it("parses typed values and omits empty optionals", () => {
    const parsed = propertiesFromForm(fields, {
      title: "Review budget",
      status: "doing",
      estimate: "3",
      urgent: true,
      due: "",
      extra: "",
    });
    expect(parsed).toEqual({
      ok: true,
      properties: { title: "Review budget", status: "doing", estimate: 3, urgent: true },
    });
  });

  it("sends null for empty optionals on update so merge can clear them", () => {
    const parsed = propertiesFromForm(
      fields,
      {
        title: "Review budget",
        status: "doing",
        estimate: "",
        urgent: true,
        due: "",
        extra: "",
      },
      { emptyAs: "null" },
    );
    expect(parsed).toEqual({
      ok: true,
      properties: {
        title: "Review budget",
        status: "doing",
        estimate: null,
        urgent: true,
        due: null,
        extra: null,
        complexity: null,
        notes: null,
        body: null,
        score: null,
      },
    });
  });

  it("rejects a missing required field", () => {
    const parsed = propertiesFromForm(fields, { title: "", status: "todo" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/title is required/);
    }
  });

  it("rejects invalid json and numbers", () => {
    expect(propertiesFromForm(fields, { title: "A", extra: "{nope" }).ok).toBe(false);
    expect(propertiesFromForm(fields, { title: "A", estimate: "nope" }).ok).toBe(false);
  });

  it("round-trips datetime-local into ISO", () => {
    const local = "2026-08-20T14:30";
    const iso = fromDatetimeLocal(local);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(toDatetimeLocal(iso)).toBe(local);
  });

  it("rejects integer, range, and maxLength violations", () => {
    expect(propertiesFromForm(fields, { title: "A", complexity: "3.5" }).ok).toBe(false);
    expect(propertiesFromForm(fields, { title: "A", complexity: "6" }).ok).toBe(false);
    expect(propertiesFromForm(fields, { title: "A", notes: "x".repeat(401) }).ok).toBe(false);
    expect(propertiesFromForm(fields, { title: "A", complexity: "4" })).toEqual({
      ok: true,
      properties: { title: "A", complexity: 4 },
    });
  });
});

describe("inspector widgets", () => {
  it("renders slider, textarea, and min/max/step on number inputs", () => {
    const html = renderInspector(schema, undefined, { kind: "create-node", type: "Task" }, true);
    expect(html).toContain('type="range"');
    expect(html).toContain('name="complexity"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="5"');
    expect(html).toContain("Complexity");
    expect(html).toContain("data-slider-enable");
    expect(html).not.toMatch(/data-slider-enable checked/);
    expect(html).toMatch(/<textarea name="notes"/);
    expect(html).toMatch(/<textarea name="body"/);
    expect(html).toContain('name="score"');
    expect(html).toContain('step="1"');
    expect(html).toContain('max="999"');
  });

  it("renders derived fields as read-only and does not submit them", () => {
    const fields = fieldsFor(schema, "node", "Task");
    const parsed = propertiesFromForm(fields, {
      title: "A",
      complexity: "3",
      effortWeight: "99",
    });
    expect(parsed).toEqual({
      ok: true,
      properties: { title: "A", complexity: 3 },
    });
    const html = renderInspector(
      schema,
      {
        schemaId: schema.config.schemaId,
        schemaHash: schema.schemaHash,
        nodes: [
          {
            id: "t1",
            type: "Task",
            properties: { title: "A", complexity: 3, effortWeight: 6 },
            meta: {},
          },
        ],
        edges: [],
      },
      { kind: "inspect-node", id: "t1" },
      true,
    );
    expect(html).toMatch(/readonly/);
    expect(html).toMatch(/disabled/);
    expect(html).toContain("effortWeight");
    expect(html).toContain('value="6"');
    expect(html).not.toMatch(/name="effortWeight"/);
  });

  it("marks an optional slider as set only when a numeric value exists", () => {
    const html = renderInspector(
      schema,
      {
        schemaId: schema.config.schemaId,
        schemaHash: schema.schemaHash,
        nodes: [
          {
            id: "t1",
            type: "Task",
            properties: { title: "A", complexity: 4 },
            meta: {},
          },
        ],
        edges: [],
      },
      { kind: "inspect-node", id: "t1" },
      true,
    );
    expect(html).toContain("data-slider-enable checked");
    expect(html).toContain('value="4"');
  });

  it("omits live CRDT fields from inspect save and shows them read-only", () => {
    const notes = parseSchemaDocument(`
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
      votes:
        type: map
`);
    const html = renderInspector(
      notes,
      {
        schemaId: notes.config.schemaId,
        schemaHash: notes.schemaHash,
        nodes: [
          {
            id: "n1",
            type: "Note",
            properties: { title: "Log", body: "## Timeline", votes: { ada: 1 } },
            meta: {},
          },
        ],
        edges: [],
      },
      { kind: "inspect-node", id: "n1" },
      true,
    );
    expect(html).toContain('name="title"');
    expect(html).not.toMatch(/name="body"/);
    expect(html).not.toMatch(/name="votes"/);
    expect(html).toContain("## Timeline");
    expect(html).toContain("session.collabText");
    expect(html).toMatch(/readonly/);
  });
});

describe("tagsFromForm", () => {
  const tagged = parseSchemaDocument(`
name: TaskBoard
version: 1
config:
  schemaId: task-board
  tags:
    enabled: true
nodes:
  Task:
    properties:
      title:
        type: string
        required: true
`);

  it("omits tags on inspect when the comma list matches the loaded node", () => {
    expect(tagsFromForm(tagged, { _tags: "rfp, Q3" }, ["rfp", "Q3"])).toBeUndefined();
  });

  it("sends [] only when the field is explicitly cleared", () => {
    expect(tagsFromForm(tagged, { _tags: "" }, ["rfp"])).toEqual([]);
  });

  it("sends the parsed set on create and when the list changed", () => {
    expect(tagsFromForm(tagged, { _tags: "rfp, Q3" })).toEqual(["rfp", "Q3"]);
    expect(tagsFromForm(tagged, { _tags: "rfp" }, ["rfp", "Q3"])).toEqual(["rfp"]);
  });
});

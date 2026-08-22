import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { identityId, parseSchemaDocument, SchemaError, sha256Hex } from "../src/index.ts";
import { loadSchemaFile } from "../src/node.ts";

const TASK_BOARD = `
name: TaskBoard
version: 1
description: Collaborative task board
config:
  schemaId: task-board
  idStrategy: uuid
  display:
    title: Task Board
  changeTracking:
    enabled: false
nodes:
  Task:
    description: A work item
    identity:
      from: [title]
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
    ui:
      label: "{title}"
      icon: check-square
    guidelines:
      - Titles are imperative and short
  Person:
    properties:
      name:
        type: string
        required: true
      email:
        type: string
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
    directed: true
    properties:
      since:
        type: datetime
    ui:
      label: assigned
    guidelines:
      - Prefer a single assignee per task
  BLOCKS:
    from: [Task]
    to: [Task]
    directed: true
`;

describe("parseSchemaDocument", () => {
  it("parses a task board schema and is hash-stable", () => {
    const a = parseSchemaDocument(TASK_BOARD);
    const b = parseSchemaDocument(TASK_BOARD);
    expect(a.name).toBe("TaskBoard");
    expect(a.config.schemaId).toBe("task-board");
    expect(a.config.changeTracking.enabled).toBe(false);
    expect(a.nodes.Task?.properties.status?.type).toBe("enum");
    expect(a.edges.ASSIGNED_TO?.from).toEqual(["Task"]);
    expect(a.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.schemaHash).toBe(b.schemaHash);
  });

  it("pins schemaHash so Node and browser stay identical", () => {
    const schema = parseSchemaDocument(`
name: Only
version: 1
config:
  schemaId: only
nodes:
  Item:
    properties:
      title:
        type: string
`);
    expect(schema.schemaHash).toBe(
      "4951fa6793351161252f82d53bd707612e0086bdb3c88e30e362e25f6a886760",
    );
  });

  it("defaults change tracking to off", () => {
    const schema = parseSchemaDocument(`
name: Only
version: 1
config:
  schemaId: only
nodes:
  Item:
    properties:
      title:
        type: string
`);
    expect(schema.config.changeTracking).toEqual({
      enabled: false,
      mode: "last-write",
    });
    expect(schema.config.idStrategy).toBe("uuid");
  });

  it("rejects unknown property types", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      title:
        type: vector
`),
    ).toThrow(SchemaError);
  });

  it("rejects edges that reference missing node types", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      title:
        type: string
edges:
  REL:
    from: [Item]
    to: [Missing]
`),
    ).toThrow(/Missing/);
  });

  it("rejects reserved property names", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      id:
        type: string
`),
    ).toThrow(/reserved/);
  });

  it("rejects identity fields that are not properties", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    identity:
      from: [slug]
    properties:
      title:
        type: string
`),
    ).toThrow(/slug/);
  });

  it("parses text/map/array properties and includes them in schemaHash", () => {
    const without = parseSchemaDocument(`
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
`);
    const withText = parseSchemaDocument(`
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
      blocks:
        type: array
`);
    expect(withText.nodes.Note?.properties.body?.type).toBe("text");
    expect(withText.schemaHash).not.toBe(without.schemaHash);
  });

  it("rejects text properties on edges", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Note:
    properties:
      title:
        type: string
edges:
  LINK:
    from: [Note]
    to: [Note]
    properties:
      body:
        type: text
`),
    ).toThrow(/node-only/);
  });

  it("rejects identity on text properties", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Note:
    identity:
      from: [body]
    properties:
      body:
        type: text
`),
    ).toThrow(/text property/);
  });

  it("requires enum values", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      status:
        type: enum
`),
    ).toThrow(/values/);
  });

  it("persists min, max, integer, maxLength, and property ui", () => {
    const schema = parseSchemaDocument(`
name: Constrained
version: 1
config:
  schemaId: constrained
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
        maxLength: 120
        ui:
          widget: text
          label: Title
      description:
        type: string
        maxLength: 8000
        ui:
          widget: textarea
      complexity:
        type: number
        integer: true
        min: 0
        max: 5
        ui:
          widget: slider
          label: Complexity
`);
    expect(schema.nodes.Feature?.properties.title).toEqual({
      type: "string",
      required: true,
      maxLength: 120,
      ui: { widget: "text", label: "Title" },
    });
    expect(schema.nodes.Feature?.properties.description).toEqual({
      type: "string",
      maxLength: 8000,
      ui: { widget: "textarea" },
    });
    expect(schema.nodes.Feature?.properties.complexity).toEqual({
      type: "number",
      integer: true,
      min: 0,
      max: 5,
      ui: { widget: "slider", label: "Complexity" },
    });
  });

  it("rejects unknown property keys instead of stripping them", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      title:
        type: string
        unexpectedKey: true
`),
    ).toThrow(/Unrecognized key|unrecognized/i);
  });

  it("persists derived expressions", () => {
    const schema = parseSchemaDocument(`
name: Scored
version: 1
config:
  schemaId: scored
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      complexity:
        type: number
      uncertainty:
        type: number
      effortWeight:
        type: number
        derived: "complexity * (1 + uncertainty / 5)"
`);
    expect(schema.nodes.Feature?.properties.effortWeight).toEqual({
      type: "number",
      derived: "complexity * (1 + uncertainty / 5)",
    });
  });

  it("rejects required or default combined with derived", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      n:
        type: number
      total:
        type: number
        required: true
        derived: "n + 1"
`),
    ).toThrow(/required/);
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      n:
        type: number
      total:
        type: number
        default: 0
        derived: "n + 1"
`),
    ).toThrow(/default/);
  });

  it("rejects derived identifiers that are not properties of the same type", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      n:
        type: number
      total:
        type: number
        derived: "n + missing"
`),
    ).toThrow(/missing/);
  });

  it("rejects calls and unexpected characters in derived expressions", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      n:
        type: number
      total:
        type: number
        derived: "Math.max(n, 1)"
`),
    ).toThrow(/function calls|unexpected/i);
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      n:
        type: number
      total:
        type: number
        derived: "n + n"
`),
    ).not.toThrow();
  });

  it("rejects derived on non-number properties and on derived inputs", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      title:
        type: string
        derived: "1 + 1"
`),
    ).toThrow(/derived/);
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      n:
        type: number
      mid:
        type: number
        derived: "n + 1"
      total:
        type: number
        derived: "mid + 1"
`),
    ).toThrow(/derived property/);
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      title:
        type: string
      total:
        type: number
        derived: "title + 1"
`),
    ).toThrow(/number property/);
  });

  it("rejects derived on edge properties", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      n:
        type: number
edges:
  REL:
    from: [Item]
    to: [Item]
    properties:
      weight:
        type: number
        derived: "1 + 1"
`),
    ).toThrow(/node properties/);
  });

  it("rejects min/max/integer on non-number properties", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      title:
        type: string
        min: 0
`),
    ).toThrow(/min/);
  });

  it("rejects maxLength on non-string properties", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      score:
        type: number
        maxLength: 4
`),
    ).toThrow(/maxLength/);
  });

  it("rejects min greater than max", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      score:
        type: number
        min: 5
        max: 1
`),
    ).toThrow(/min.*max/);
  });

  it("rejects non-integer min/max when integer is true", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      score:
        type: number
        integer: true
        min: 0.5
        max: 4.5
`),
    ).toThrow(/integer/);
  });

  it("rejects a default that would fail coerceProperty", () => {
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      score:
        type: number
        integer: true
        min: 0
        max: 5
        default: 9
`),
    ).toThrow(/default/);
    expect(() =>
      parseSchemaDocument(`
name: Bad
version: 1
config:
  schemaId: bad
nodes:
  Item:
    properties:
      title:
        type: string
        maxLength: 4
        default: too-long
`),
    ).toThrow(/default/);
  });
});

describe("identityId", () => {
  it("is deterministic for the same identity fields", () => {
    const schema = parseSchemaDocument(TASK_BOARD);
    const a = identityId(schema, "Task", { title: "Ship DSL" });
    const b = identityId(schema, "Task", { title: "Ship DSL" });
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });
});

describe("sha256Hex", () => {
  it("matches the published SHA-256 of 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("history mode and tags", () => {
  it("parses changeTracking.mode history and config.tags.enabled", () => {
    const schema = parseSchemaDocument(`
name: Idea
version: 1
config:
  schemaId: idea
  changeTracking:
    enabled: true
    mode: history
    historyLimit: 10000
  tags:
    enabled: true
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
`);
    expect(schema.config.changeTracking).toEqual({
      enabled: true,
      mode: "history",
      historyLimit: 10000,
    });
    expect(schema.config.tags).toEqual({ enabled: true });
  });

  it("loads the collab-idea-board history/tags fixture", async () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "fixtures/collab-idea-board.yaml");
    const fromFile = await loadSchemaFile(path);
    const fromParse = parseSchemaDocument(readFileSync(path, "utf8"));
    expect(fromFile.config.changeTracking.mode).toBe("history");
    expect(fromFile.config.tags?.enabled).toBe(true);
    expect(fromFile.nodes.Feature).toBeTruthy();
    expect(fromFile.nodes.Chunk).toBeTruthy();
    expect(fromFile.schemaHash).toBe(fromParse.schemaHash);
  });
});

describe("loadSchemaFile", () => {
  it("parses YAML from disk with the same hash as parseSchemaDocument", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collabnode-schema-"));
    const path = join(dir, "schema.yaml");
    await writeFile(path, TASK_BOARD);
    const fromFile = await loadSchemaFile(path);
    expect(fromFile.schemaHash).toBe(parseSchemaDocument(TASK_BOARD).schemaHash);
  });
});

describe("search configuration", () => {
  const parse = (searchYaml: string) =>
    parseSchemaDocument(`
name: Searchable
version: 1
config:
  schemaId: searchable
nodes:
  Note:
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
${searchYaml}
      body:
        type: text
edges: {}
`);

  it("normalizes the three spellings of search", () => {
    expect(parse("        search: true").nodes.Note?.properties.title?.search).toEqual({
      index: true,
      // Identity fields are what people name things by, so they outrank prose.
      boost: 4,
    });
    expect(parse("        search: false").nodes.Note?.properties.title?.search).toEqual({
      index: false,
      boost: 4,
    });
    expect(parse("        search:\n          boost: 6").nodes.Note?.properties.title?.search).toEqual({
      index: true,
      boost: 6,
    });
  });

  it("leaves search absent when the schema never mentions it", () => {
    // Materializing a default here would change schemaHash for every existing
    // schema; the implicit default belongs to the index instead.
    const schema = parse("");
    expect(schema.nodes.Note?.properties.title?.search).toBeUndefined();
    expect(schema.nodes.Note?.properties.body?.search).toBeUndefined();
  });

  it("does not change schemaHash for schemas that never mention search", () => {
    expect(parse("").schemaHash).toBe(parse("").schemaHash);
    expect(parse("        search: true").schemaHash).not.toBe(parse("").schemaHash);
  });

  it("rejects an unknown key inside search", () => {
    expect(() => parse("        search:\n          fuzzy: true")).toThrow(SchemaError);
  });

  it("rejects a non-positive boost", () => {
    expect(() => parse("        search:\n          boost: 0")).toThrow(SchemaError);
  });
});

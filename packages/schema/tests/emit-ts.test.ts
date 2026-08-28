import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspaceTypeFile } from "../src/node.ts";
import { workspaceToTypescript } from "../src/emit-ts.ts";
import { parseWorkspaceTypeDocument } from "../src/workspace-type.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/every-property-type.yaml");

async function emit(options?: Parameters<typeof workspaceToTypescript>[1]): Promise<string> {
  const workspace = await loadWorkspaceTypeFile(fixture);
  return workspaceToTypescript(workspace, { importFrom: "collabnode", ...options });
}

describe("workspaceToTypescript", () => {
  it("emits a const the types are derived from, and the type map beside it", async () => {
    const source = await emit();
    expect(source).toContain("as const satisfies WorkspaceTypeLiteral");
    expect(source).toContain("export type TypeEmitterFixture = GraphTypes<typeof typeEmitterFixture>");
    expect(source).toContain('export type NodeTypeName = keyof TypeEmitterFixture["nodes"] & string');
  });

  it("maps each property type the way the runtime coerces it", async () => {
    const source = await emit();
    const sample = block(source, "SampleProps");

    expect(sample).toContain("name: string;");
    expect(sample).toContain("note?: string;");
    expect(sample).toContain('stage: "draft" | "review" | "done";');
    expect(sample).toContain("score?: number;");
    expect(sample).toContain("flag: boolean;");
    expect(sample).toContain("when?: string;");
    // json is stringified by `coerceProperty`, so it reads back as a string
    expect(sample).toContain("payload?: string;");
  });

  it("treats CRDT properties as always present, because hydrateNode fills them in", async () => {
    const sample = block(await emit(), "SampleProps");
    expect(sample).toContain("body: string;");
    expect(sample).toContain("labels: unknown[];");
    expect(sample).toContain("extras: Record<string, unknown>;");
  });

  it("makes a property with a default present on read", async () => {
    // `stage` is not `required`, but create fills the default in, so it is there.
    expect(block(await emit(), "SampleProps")).toContain('stage: "draft" | "review" | "done";');
  });

  it("marks a derived property readonly and optional", async () => {
    expect(block(await emit(), "SampleProps")).toContain("readonly doubled?: number;");
  });

  it("carries the YAML's own prose, and the bounds the type cannot hold", async () => {
    const source = await emit();
    expect(source).toContain("/** What the sample is called. At most 120 characters. */");
    expect(source).toContain("/** How good it is. From 1 to 10. */");
    // Node-level description and guidelines become the interface's doc comment.
    expect(source).toContain("Every property type the schema language has.");
    expect(source).toContain("Keep this fixture exhaustive");
  });

  it("pins each emitted interface to the inferred shape", async () => {
    const source = await emit();
    expect(source).toContain(
      'export type _AssertSampleProps = Expect<Equal<SampleProps, NodeProps<typeof typeEmitterFixture, "Sample">>>',
    );
  });

  it("emits the write, strict and record aliases per node type", async () => {
    const source = await emit();
    expect(source).toContain('export type SampleInput = NodeInput<typeof typeEmitterFixture, "Sample">');
    expect(source).toContain('export type SampleStrict = StrictInput<typeof typeEmitterFixture, "Sample">');
    expect(source).toContain('export type SampleNode = GraphNodeRecord<TypeEmitterFixture, "Sample">');
  });

  it("emits edge endpoints as the declared node types", async () => {
    expect(await emit()).toContain(
      'export type LinksToEdge = { from: "Sample"; to: "Sample" | "Other" };',
    );
  });

  it("records the schema hash, so a stale file can be spotted", async () => {
    const workspace = await loadWorkspaceTypeFile(fixture);
    expect(await emit()).toContain(`export const SCHEMA_HASH = "${workspace.schema.schemaHash}"`);
  });

  it("trims the literal to what the types read, unless asked for the whole thing", async () => {
    const trimmed = await emit();
    const full = await emit({ full: true });

    // Prose does not affect a single derived type, and there is a lot of it.
    expect(trimmed).not.toContain('"idStrategy"');
    expect(trimmed).not.toContain('"guidelines"');
    expect(full).toContain('"idStrategy"');
    expect(full.length).toBeGreaterThan(trimmed.length);

    // What the types do read survives the trim.
    expect(trimmed).toContain('"values": [');
    expect(trimmed).toContain('"derived": "score + score"');
    expect(trimmed).toContain('"required": true');
  });

  it("names the const and type after the workspace unless told otherwise", async () => {
    const named = await emit({ name: "MyBoard" });
    expect(named).toContain("export const myBoard = {");
    expect(named).toContain("export type MyBoard = GraphTypes<typeof myBoard>");
  });

  it("is stable across runs, so --check does not report phantom drift", async () => {
    expect(await emit()).toBe(await emit());
  });

  it("escapes prose that would close the JSDoc block early", () => {
    const closer = `*${"/"}`;
    const workspace = parseWorkspaceTypeDocument(`
type: doc-escape
version: 1
description:
  en: Doc Escape
schema:
  name: DocEscape
  version: 1
  config:
    schemaId: doc-escape
    idStrategy: uuid
  nodes:
    Sample:
      description:
        en: A glob like ${closer} ends the comment.
      guidelines:
        en:
          - Never write ${closer} in a guideline either.
      properties:
        name:
          type: string
          required: true
          description:
            en: Matches ${closer} patterns.
`);
    const source = workspaceToTypescript(workspace, { importFrom: "collabnode" });

    // The prose survives, with the one sequence that would end the block early
    // escaped — anywhere it does not, the generated module stops parsing.
    expect(source).toContain(`A glob like *\\${"/"} ends the comment.`);
    expect(source).toContain(`Matches *\\${"/"} patterns.`);
    expect(source).toContain(`Never write *\\${"/"} in a guideline either.`);
    expect(source).not.toContain(`like ${closer}`);
    expect(source).not.toContain(`Matches ${closer}`);
    expect(source).not.toContain(`write ${closer}`);
  });

});

/** The body of one emitted interface, so a test can assert on its members alone. */
function block(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}", start));
}

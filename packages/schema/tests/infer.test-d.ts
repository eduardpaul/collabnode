import { describe, expectTypeOf, test } from "vitest";
import type {
  GraphTypes,
  NodeCreate,
  NodeInput,
  NodeProps,
  StrictInput,
  WorkspaceTypeLiteral,
} from "../src/index.js";

/**
 * The mapping rules have no runtime to exercise — they are only ever wrong at
 * compile time — so this file is checked by `vitest --typecheck` rather than
 * executed. Every case here corresponds to a branch of `coerceProperty`,
 * `coerceProperties` or `hydrateNode`: the types are a claim about what the
 * runtime does, and this is where the claim is stated.
 */

// Only ever used as a type, via `typeof`.
const _ws = {
  name: "Probe",
  schema: {
    name: "ProbeGraph",
    nodes: {
      Epic: {
        properties: {
          title: { type: "string", required: true },
          description: { type: "text" },
          priority: { type: "enum", values: ["low", "medium", "high"], default: "medium" },
          dirty: { type: "boolean", default: false },
          nickname: { type: "string" },
        },
      },
      Task: {
        properties: {
          title: { type: "string", required: true },
          functionalPoints: { type: "number", integer: true, min: 1, max: 21 },
          totalPoints: { type: "number", derived: "functionalPoints + technicalPoints" },
          payload: { type: "json" },
          labels: { type: "array" },
          meta: { type: "map" },
          dueAt: { type: "datetime" },
        },
      },
    },
    edges: {
      HAS_TASK: { from: ["Epic"], to: ["Task"], directed: true, properties: {} },
      BLOCKS: {
        from: ["Task"],
        to: ["Task", "Epic"],
        directed: true,
        properties: { reason: { type: "string", required: true } },
      },
    },
  },
} as const satisfies WorkspaceTypeLiteral;

type W = typeof _ws;
type EpicProps = NodeProps<W, "Epic">;
type TaskProps = NodeProps<W, "Task">;
type EpicInput = NodeInput<W, "Epic">;
type TaskInput = NodeInput<W, "Task">;

describe("read shapes", () => {
  test("scalars follow the property type", () => {
    expectTypeOf<EpicProps["title"]>().toEqualTypeOf<string>();
    expectTypeOf<TaskProps["functionalPoints"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<EpicProps["dirty"]>().toEqualTypeOf<boolean>();
  });

  test("an enum reads as the union of its values, never an open string", () => {
    expectTypeOf<EpicProps["priority"]>().toEqualTypeOf<"low" | "medium" | "high">();
  });

  test("a property with a default is present, because create fills it in", () => {
    expectTypeOf<EpicProps>().toHaveProperty("priority");
    expectTypeOf<EpicProps["priority"]>().not.toEqualTypeOf<"low" | "medium" | "high" | undefined>();
  });

  test("a plain optional property may be missing", () => {
    expectTypeOf<EpicProps["nickname"]>().toEqualTypeOf<string | undefined>();
  });

  test("CRDT fields are always present — hydrateNode materializes them", () => {
    expectTypeOf<EpicProps["description"]>().toEqualTypeOf<string>();
    expectTypeOf<TaskProps["labels"]>().toEqualTypeOf<unknown[]>();
    expectTypeOf<TaskProps["meta"]>().toEqualTypeOf<Record<string, unknown>>();
  });

  test("json reads back as a string, because the runtime stringifies it", () => {
    expectTypeOf<TaskProps["payload"]>().toEqualTypeOf<string | undefined>();
  });

  test("datetime is an ISO string", () => {
    expectTypeOf<TaskProps["dueAt"]>().toEqualTypeOf<string | undefined>();
  });

  test("a derived property is readable but optional", () => {
    expectTypeOf<TaskProps["totalPoints"]>().toEqualTypeOf<number | undefined>();
  });
});

describe("write shapes", () => {
  test("every property is optional, because an upsert merges into what is stored", () => {
    expectTypeOf<{ title: string }>().toExtend<EpicInput>();
    expectTypeOf<{ priority: "low" }>().toExtend<EpicInput>();
    expectTypeOf<Record<string, never>>().toExtend<EpicInput>();
  });

  test("a create still has to supply required properties", () => {
    type EpicCreate = NodeCreate<W, "Epic">;
    expectTypeOf<{ title: string }>().toExtend<EpicCreate>();
    expectTypeOf<{ priority: "low" }>().not.toExtend<EpicCreate>();
  });

  test("an enum rejects a value outside its declared set", () => {
    expectTypeOf<{ title: string; priority: "urgent" }>().not.toExtend<EpicInput>();
    expectTypeOf<{ title: string; priority: "high" }>().toExtend<EpicInput>();
  });

  test("optional properties accept null, which is how a value is cleared", () => {
    expectTypeOf<{ title: string; nickname: null }>().toExtend<EpicInput>();
  });

  test("derived properties are not writable at all", () => {
    expectTypeOf<TaskInput>().not.toHaveProperty("totalPoints");
  });

  test("json accepts any value on the way in", () => {
    expectTypeOf<{ title: string; payload: { nested: true } }>().toExtend<TaskInput>();
  });
});

/**
 * What a developer actually writes is a fresh object literal, and that is the
 * only form excess-property checking applies to — `expectTypeOf` compares types,
 * where an extra property is structurally harmless. So the rejections that
 * matter at a real call site are asserted as literals.
 */
// @ts-expect-error `totalPoints` is derived: the runtime computes it and drops writes to it
const derivedWrite: TaskInput = { title: "t", totalPoints: 5 };
// @ts-expect-error `priority` is an enum, not an open string
const badEnum: EpicInput = { title: "x", priority: "urgent" };
// An upsert with no title is a legitimate partial update of an existing Epic.
const partialUpdate: EpicInput = { priority: "low" };
// @ts-expect-error a create has nothing to merge into, so `title` must be there
const missingRequired: NodeCreate<W, "Epic"> = { priority: "low" };
// @ts-expect-error `nope` is not a property of Epic at all
const unknownProperty: EpicInput = { title: "x", nope: 1 };

const validCreate: EpicInput = { title: "x" };
const validClear: EpicInput = { title: "x", nickname: null };

export { derivedWrite, badEnum, partialUpdate, missingRequired, unknownProperty, validCreate, validClear };

describe("strict shape for structured output", () => {
  test("every key is present, with null standing in for no value", () => {
    type EpicStrict = StrictInput<W, "Epic">;
    expectTypeOf<{
      title: string;
      description: null;
      priority: null;
      dirty: null;
      nickname: null;
    }>().toExtend<EpicStrict>();
    expectTypeOf<{ title: string }>().not.toExtend<EpicStrict>();
  });
});

describe("the type map", () => {
  type Probe = GraphTypes<W>;

  test("node and edge names come from the schema", () => {
    expectTypeOf<keyof Probe["nodes"]>().toEqualTypeOf<"Epic" | "Task">();
    expectTypeOf<keyof Probe["edges"]>().toEqualTypeOf<"HAS_TASK" | "BLOCKS">();
  });

  test("edge endpoints are the declared node types", () => {
    expectTypeOf<Probe["edges"]["HAS_TASK"]["from"]>().toEqualTypeOf<"Epic">();
    expectTypeOf<Probe["edges"]["BLOCKS"]["to"]>().toEqualTypeOf<"Task" | "Epic">();
  });

  test("edge properties follow the same rules as node properties", () => {
    expectTypeOf<Probe["edges"]["BLOCKS"]["props"]["reason"]>().toEqualTypeOf<string>();
  });

  test("the map carries both halves of each node type", () => {
    expectTypeOf<Probe["nodes"]["Epic"]["props"]>().toEqualTypeOf<EpicProps>();
    expectTypeOf<Probe["nodes"]["Epic"]["input"]>().toEqualTypeOf<EpicInput>();
  });
});

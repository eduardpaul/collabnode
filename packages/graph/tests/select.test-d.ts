import { describe, expectTypeOf, test } from "vitest";
import { findOfType, nodeOfType, nodesOfType, ofType, singletonOfType } from "../src/select.ts";
import type { GraphSnapshot } from "../src/ops.ts";

/**
 * The selectors exist for their types — at runtime they are a `filter` — so
 * this is where they are actually tested. Checked by `vitest --typecheck`.
 */

interface Board {
  nodes: {
    Epic: {
      props: { title: string; priority: "low" | "high" };
      input: { title?: string };
      strict: { title: string };
    };
    Task: {
      props: { title: string; points?: number };
      input: { title?: string };
      strict: { title: string };
    };
  };
  edges: {
    HAS_TASK: { from: "Epic"; to: "Task"; props: { rank: number }; input: { rank?: number } };
  };
}

declare const board: GraphSnapshot<Board>;

describe("nodesOfType", () => {
  test("narrows the elements to that type's own properties", () => {
    expectTypeOf(nodesOfType(board, "Epic")[0]!.properties).toEqualTypeOf<{
      title: string;
      priority: "low" | "high";
    }>();
    expectTypeOf(nodesOfType(board, "Task")[0]!.properties.points).toEqualTypeOf<
      number | undefined
    >();
  });

});

// Rejections are stated at module scope: the `@ts-expect-error` *is* the
// assertion, and a `test()` whose body is only a directive reads as a test with
// nothing in it.

// @ts-expect-error "Epci" is not a node type on this board
nodesOfType(board, "Epci");
// @ts-expect-error `points` belongs to Task, not Epic
nodesOfType(board, "Epic")[0]?.properties.points;

describe("nodeOfType and singletonOfType", () => {
  test("carry the same narrowing, and may be absent", () => {
    expectTypeOf(nodeOfType(board, "Task", "id")?.properties.title).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(singletonOfType(board, "Epic")?.properties.priority).toEqualTypeOf<
      "low" | "high" | undefined
    >();
  });
});

describe("ofType and findOfType", () => {
  test("work on anything discriminated on `type`, such as a plan's entries", () => {
    const entries = [] as ({ type: "Epic"; ref: string } | { type: "Task"; points: number })[];
    expectTypeOf(ofType(entries, "Task")[0]!.points).toEqualTypeOf<number>();
    expectTypeOf(findOfType(entries, "Epic")?.ref).toEqualTypeOf<string | undefined>();
  });

  test("the predicate sees the narrowed member", () => {
    const entries = [] as ({ type: "Epic"; ref: string } | { type: "Task"; points: number })[];
    findOfType(entries, "Task", (entry) => {
      expectTypeOf(entry.points).toEqualTypeOf<number>();
      return true;
    });
  });

});

declare const planEntries: ({ type: "Epic"; ref: string } | { type: "Task"; points: number })[];
// @ts-expect-error "Risk" is not one of these entries
ofType(planEntries, "Risk");

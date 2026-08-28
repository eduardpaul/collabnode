import { describe, expect, it } from "vitest";
import { parseWorkspaceTypeDocument } from "../src/index.ts";

/** A workspace whose `views:` block is spliced in per test. */
function doc(views: string, agents = ""): string {
  return `
type: planner
version: 1
nodes:
  Epic:
    properties:
      title: { type: string, required: true }
      priority: { type: enum, values: [low, high] }
  Task:
    properties:
      title: { type: string, required: true }
      points: { type: number }
edges:
  HAS_TASK:
    from: [Epic]
    to: [Task]
    directed: true
${views}
${agents}
`;
}

const REVIEW_PLAN = `
views:
  review_plan:
    title:
      en: Review plan
      es: Revisar plan
    description:
      en: Epics and their tasks.
    guidance:
      en:
        - Check every Epic has a Task.
    params:
      epic:
        type: string
        description:
          en: Epic title. Omit for the whole plan.
    select:
      roots:
        types: [Epic]
        where: "params.epic == null || title == params.epic"
      traverse:
        edges: [HAS_TASK]
        direction: out
        depth: 2
    fields:
      Epic: [title, priority]
      Task: [title, points]
    maxNodes: 50
`;

describe("views", () => {
  it("parses and normalizes a full view", () => {
    const type = parseWorkspaceTypeDocument(doc(REVIEW_PLAN));
    const view = type.views?.review_plan;

    expect(view).toBeDefined();
    expect(view?.title).toEqual({ en: "Review plan", es: "Revisar plan" });
    expect(view?.params?.epic?.type).toBe("string");
    expect(view?.select?.roots?.types).toEqual(["Epic"]);
    expect(view?.select?.traverse?.depth).toBe(2);
    expect(view?.fields?.Task).toEqual(["title", "points"]);
    expect(view?.maxNodes).toBe(50);
  });

  it("leaves views undefined when the document declares none", () => {
    expect(parseWorkspaceTypeDocument(doc("")).views).toBeUndefined();
  });

  it("accepts the `*` fields fallback and the id/type pseudo-fields", () => {
    const type = parseWorkspaceTypeDocument(
      doc(`
views:
  bare:
    fields:
      Epic: [id, type, title]
      "*": [title]
`),
    );
    expect(type.views?.bare.fields?.["*"]).toEqual(["title"]);
  });

  it("rejects an undeclared root node type", () => {
    expect(() =>
      parseWorkspaceTypeDocument(doc(`
views:
  bad:
    select:
      roots:
        types: [Ghost]
`)),
    ).toThrow(/undeclared node type 'Ghost'/);
  });

  it("rejects an undeclared included node type", () => {
    expect(() =>
      parseWorkspaceTypeDocument(doc(`
views:
  bad:
    select:
      include: [Ghost]
`)),
    ).toThrow(/includes undeclared node type 'Ghost'/);
  });

  it("rejects an undeclared traversed edge type", () => {
    expect(() =>
      parseWorkspaceTypeDocument(doc(`
views:
  bad:
    select:
      traverse:
        edges: [HAS_GHOST]
`)),
    ).toThrow(/undeclared edge type 'HAS_GHOST'/);
  });

  it("rejects a field that is not a property of its node type", () => {
    expect(() =>
      parseWorkspaceTypeDocument(doc(`
views:
  bad:
    fields:
      Epic: [title, nonesuch]
`)),
    ).toThrow(/undeclared property 'nonesuch' of node type 'Epic'/);
  });

  it("rejects a where expression that does not parse", () => {
    expect(() =>
      parseWorkspaceTypeDocument(doc(`
views:
  bad:
    select:
      roots:
        where: "title =="
`)),
    ).toThrow();
  });

  it("rejects a view name that would shadow a generated tool", () => {
    expect(() =>
      parseWorkspaceTypeDocument(doc(`
views:
  graph_list:
    fields:
      Epic: [title]
`)),
    ).toThrow(/must not start with 'graph_'/);
  });

  it("rejects a view name that is not a usable tool-name fragment", () => {
    expect(() =>
      parseWorkspaceTypeDocument(doc(`
views:
  "review plan":
    fields:
      Epic: [title]
`)),
    ).toThrow(/must be alphanumeric/);
  });

  it("rejects a view colliding with a named tool", () => {
    expect(() =>
      parseWorkspaceTypeDocument(doc(REVIEW_PLAN, `
tools:
  named:
    review_plan:
      creates: Epic
`)),
    ).toThrow(/collides with a named tool/);
  });

  it("rejects an agent granting a view that does not exist", () => {
    expect(() =>
      parseWorkspaceTypeDocument(doc(REVIEW_PLAN, `
tools:
  agents:
    - role: manager
      actorId: ai-manager
      views: [review_plan, nonesuch]
`)),
    ).toThrow(/agent 'manager' grants undeclared view 'nonesuch'/);
  });

  it("accepts an agent granting declared views and the wildcard", () => {
    const type = parseWorkspaceTypeDocument(doc(REVIEW_PLAN, `
tools:
  agents:
    - role: manager
      actorId: ai-manager
      views: [review_plan]
    - role: architect
      actorId: ai-architect
      views: ["*"]
`));
    expect(type.tools?.agents?.[0]?.views).toEqual(["review_plan"]);
    expect(type.tools?.agents?.[1]?.views).toEqual(["*"]);
  });
});

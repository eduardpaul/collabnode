import { InMemoryCollabBackend } from "@collabnode/collab";
import { CollabSession } from "@collabnode/runtime";
import { parseWorkspaceTypeDocument } from "@collabnode/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { buildTools } from "../src/index.ts";

const TYPE_YAML = `
type: planner
version: 1
schema:
  nodes:
    Epic:
      properties:
        title: { type: string, required: true }
        priority: { type: string, default: "medium" }
    Task:
      properties:
        title: { type: string, required: true }
        points: { type: number, default: 1 }
    Secret:
      properties:
        title: { type: string, required: true }
  edges:
    HAS_TASK:
      from: [Epic]
      to: [Task]
      directed: true

views:
  review_plan:
    title:
      en: Review plan
    description:
      en: Epics and their tasks with estimations.
    guidance:
      en:
        - Points must be Fibonacci integers.
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
    fields:
      Epic: [priority]
      Task: [points]

  secrets:
    description:
      en: The secrets nobody should see.
    select:
      roots:
        types: [Secret]

tools:
  expose:
    - graph_describe
  agents:
    - role: manager
      actorId: ai-manager
      views: [review_plan]
    - role: architect
      actorId: ai-architect
    - role: outsider
      actorId: ai-outsider
      nodes:
        hidden: [Secret]
`;

const wsType = parseWorkspaceTypeDocument(TYPE_YAML);
const schema = wsType.schema;

let session: CollabSession;

beforeEach(async () => {
  session = await CollabSession.open(undefined, {
    schema,
    collab: new InMemoryCollabBackend(),
  });
  const epic = await session.upsertNode({
    type: "Epic",
    properties: { title: "Checkout", priority: "high" },
  });
  const task = await session.upsertNode({
    type: "Task",
    properties: { title: "Cart", points: 3 },
  });
  await session.upsertNode({ type: "Epic", properties: { title: "Billing", priority: "low" } });
  await session.upsertNode({ type: "Secret", properties: { title: "API key" } });
  await session.upsertEdge({ type: "HAS_TASK", from: epic, to: task });
});

function toolsFor(agentRole?: string) {
  return buildTools(schema, session, {
    policy: wsType.tools,
    views: wsType.views,
    agentRole,
    graphKind: "memory",
  });
}

const names = (agentRole?: string) => toolsFor(agentRole).map((t) => t.name);

async function call(agentRole: string | undefined, name: string, args = {}) {
  const tool = toolsFor(agentRole).find((t) => t.name === name);
  if (!tool) {
    throw new Error(`no tool ${name}; have ${names(agentRole).join(", ")}`);
  }
  const result = await tool.handler(args);
  return result.content[0]!.text;
}

describe("generated view tools", () => {
  it("exposes one tool per view, named view_<name>", () => {
    expect(names()).toContain("view_review_plan");
    expect(names()).toContain("view_secrets");
  });

  it("survives a narrow tools.expose allowlist, like named tools do", () => {
    // `expose` lists only graph_describe, yet the declared view is still there:
    // an allowlist written before views existed should not silently drop them.
    expect(names()).toContain("graph_describe");
    expect(names()).not.toContain("graph_list");
    expect(names()).toContain("view_review_plan");
  });

  it("grants only the views an agent lists", () => {
    expect(names("manager")).toContain("view_review_plan");
    expect(names("manager")).not.toContain("view_secrets");
  });

  it("grants every view to an agent that lists none", () => {
    expect(names("architect")).toContain("view_review_plan");
    expect(names("architect")).toContain("view_secrets");
  });

  it("withholds a view whose roots are all hidden from the role", () => {
    // The tool would only ever answer "nothing", and offering it would tell the
    // model that a type it must not know about exists.
    expect(names("outsider")).not.toContain("view_secrets");
    expect(names("outsider")).toContain("view_review_plan");
  });

  it("describes itself with the view's description and guidance", () => {
    const tool = toolsFor().find((t) => t.name === "view_review_plan");
    expect(tool?.description).toContain("Epics and their tasks with estimations.");
    expect(tool?.description).toContain("Points must be Fibonacci integers.");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("builds its input schema from the view's params", () => {
    const tool = toolsFor().find((t) => t.name === "view_review_plan");
    // Optional param: callable with no arguments at all.
    expect(() => tool!.inputSchema.parse({})).not.toThrow();
    expect(() => tool!.inputSchema.parse({ epic: "Checkout" })).not.toThrow();
    expect(() => tool!.inputSchema.parse({ epic: 7 })).toThrow();
  });

  it("renders markdown scoped by the parameter", async () => {
    const all = await call(undefined, "view_review_plan");
    expect(all).toContain("Checkout");
    expect(all).toContain("Billing");

    const scoped = await call(undefined, "view_review_plan", { epic: "Checkout" });
    expect(scoped).toContain("Checkout");
    expect(scoped).not.toContain("Billing");
    // Only the projected fields.
    expect(scoped).toContain("*points*: 3");
    expect(scoped).not.toContain("*title*");
  });
});

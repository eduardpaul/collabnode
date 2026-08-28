import { describe, expect, it } from "vitest";
import { InMemoryCollabBackend } from "@collabnode/collab";
import { CollabSession } from "@collabnode/runtime";
import { parseWorkspaceTypeDocument } from "@collabnode/schema";
import { getDeepAgentConfig, createSubAgentConfig } from "../src/index.js";

const SAMPLE_YAML = `
type: test-planner
version: 1
description:
  en: Test Planner
schema:
  name: TestPlanner
  version: 1
  config:
    schemaId: test-planner
    idStrategy: uuid
    changeTracking:
      enabled: true
      mode: history
  nodes:
    Goal:
      properties:
        title:
          type: string
          required: true
    Task:
      properties:
        title:
          type: string
          required: true
        status:
          type: enum
          values: [todo, done]
          default: todo
  edges:
    HAS_TASK:
      from: [Goal]
      to: [Task]
      directed: true

tools:
  expose:
    - upsert_node_Goal
    - upsert_node_Task
    - upsert_edge_HAS_TASK
    - graph_get
    - graph_list
  agents:
    - role: manager
      actorId: ai-manager
      internalPlanning: true
      description:
        en: AI Project Manager
      systemPrompt:
        en: You are a Project Manager. Define goals.
      tools:
        - upsert_node_Goal
        - graph_get
        - graph_list
      nodes:
        readOnly: [Task]

    - role: worker
      actorId: ai-worker
      internalPlanning: false
      description:
        en: AI Task Worker
      systemPrompt:
        en: You are a Task Worker. Create tasks.
      tools:
        - upsert_node_Task
        - upsert_edge_HAS_TASK
        - graph_get
`;

describe("@collabnode/deepagents configuration provider", () => {
  const workspaceType = parseWorkspaceTypeDocument(SAMPLE_YAML);

  async function createTestSession() {
    const backend = new InMemoryCollabBackend();
    return await CollabSession.open("doc-test-1", {
      collab: backend,
      schema: workspaceType.schema,
      actorId: "server",
    });
  }

  it("generates manager agent config with internal planning, actorId and filtered tools", async () => {
    const session = await createTestSession();
    const config = getDeepAgentConfig({
      session,
      workspaceType,
      role: "manager",
      language: "en",
    });

    expect(config.role).toBe("manager");
    expect(config.actorId).toBe("ai-manager");
    expect(config.internalPlanning).toBe(true);
    expect(config.systemPrompt).toContain("You are a Project Manager");
    expect(config.systemPrompt).toContain("Test Planner");

    // Manager should have upsert_node_Goal, graph_get, graph_list
    const toolNames = config.tools.map((t) => t.name);
    expect(toolNames).toContain("upsert_node_Goal");
    expect(toolNames).toContain("graph_get");
    expect(toolNames).toContain("graph_list");
    // Manager does not have Task write tools (readOnly: [Task] and not in tools list)
    expect(toolNames).not.toContain("upsert_node_Task");

    // Check middleware array contains TodoListMiddleware
    expect(config.middleware).toBeDefined();
    expect(config.middleware?.length).toBeGreaterThan(0);
  });

  it("generates worker agent config without internal planning", async () => {
    const session = await createTestSession();
    const config = getDeepAgentConfig({
      session,
      workspaceType,
      role: "worker",
      language: "en",
    });

    expect(config.role).toBe("worker");
    expect(config.actorId).toBe("ai-worker");
    expect(config.internalPlanning).toBe(false);
    expect(config.systemPrompt).toContain("You are a Task Worker");

    const toolNames = config.tools.map((t) => t.name);
    expect(toolNames).toContain("upsert_node_Task");
    expect(toolNames).toContain("upsert_edge_HAS_TASK");
    expect(toolNames).not.toContain("upsert_node_Goal");

    // Middleware should be undefined since internalPlanning is false and no extra middleware provided
    expect(config.middleware).toBeUndefined();
  });

  it("allows overriding internalPlanning, extraTools, and actorId via options", async () => {
    const session = await createTestSession();
    const config = getDeepAgentConfig({
      session,
      workspaceType,
      role: "worker",
      internalPlanning: true, // override false -> true
      actorId: "custom-worker",
      systemPromptSuffix: "Respond with brevity.",
    });

    expect(config.actorId).toBe("custom-worker");
    expect(config.internalPlanning).toBe(true);
    expect(config.middleware?.length).toBeGreaterThan(0);
    expect(config.systemPrompt).toContain("Respond with brevity.");
  });

  it("creates valid subagent configuration for deepagent delegation", async () => {
    const session = await createTestSession();
    const subagent = createSubAgentConfig({
      session,
      workspaceType,
      role: "worker",
      language: "en",
    });

    expect(subagent.name).toBe("worker");
    expect(subagent.description).toBe("AI Task Worker");
    expect(subagent.systemPrompt).toContain("You are a Task Worker");
    expect(subagent.tools.map((t) => t.name)).toContain("upsert_node_Task");
  });

  it("holds a subagent to the same tools policy as the parent agent", async () => {
    const session = await createTestSession();
    const parent = getDeepAgentConfig({ session, workspaceType, role: "manager", language: "en" });
    const subagent = createSubAgentConfig({ session, workspaceType, role: "manager", language: "en" });

    const parentTools = new Set(parent.tools.map((t) => t.name));
    const extra = subagent.tools.map((t) => t.name).filter((name) => !parentTools.has(name));

    // Dropping `toolsPolicy` here used to hand the subagent the unfiltered
    // surface: every `tools.expose` entry plus writes to `nodes.readOnly` types.
    expect(extra).toEqual([]);
    expect(subagent.tools.map((t) => t.name)).not.toContain("upsert_node_Task");
    expect(subagent.tools.map((t) => t.name)).not.toContain("upsert_edge_HAS_TASK");
  });

  it("marks each graph tool read-only or not, from the schema's own annotation", async () => {
    const session = await createTestSession();
    const config = getDeepAgentConfig({ session, workspaceType, role: "manager" });
    const readOnlyOf = (name: string) =>
      (config.tools.find((t) => t.name === name)?.metadata as { readOnly?: boolean } | undefined)
        ?.readOnly;

    expect(readOnlyOf("graph_get")).toBe(true);
    expect(readOnlyOf("graph_list")).toBe(true);
    expect(readOnlyOf("upsert_node_Goal")).toBe(false);
  });

  it("executes tool calls in real time against the CollabSession stamped with actorId", async () => {
    const session = await createTestSession();
    const toolLogs: any[] = [];

    const config = getDeepAgentConfig({
      session,
      workspaceType,
      role: "manager",
      onToolCall: (event) => toolLogs.push(event),
    });

    const goalTool = config.tools.find((t) => t.name === "upsert_node_Goal");
    expect(goalTool).toBeDefined();

    // Invoke tool call directly
    const result = await goalTool!.invoke({
      title: "Launch V1 Product",
    });

    expect(typeof result).toBe("string");
    expect(toolLogs.length).toBe(1);
    expect(toolLogs[0].name).toBe("upsert_node_Goal");
    expect(toolLogs[0].actorId).toBe("ai-manager");

    // Verify CollabSession state has the new Goal node
    const snapshot = session.snapshot();
    const goalNode = snapshot.nodes.find((n) => n.type === "Goal");
    expect(goalNode).toBeDefined();
    expect(goalNode?.properties.title).toBe("Launch V1 Product");
  });
});

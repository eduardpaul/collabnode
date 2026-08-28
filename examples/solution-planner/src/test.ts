import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { getChatModel } from "./agent/llm.ts";
import { createSubAgentConfig, getDeepAgentConfig } from "@collabnode/deepagents";
import { snapshotToMermaid } from "./mermaid/dsl.ts";
import { markDirtyAndCascade, dirtyNodes } from "./agent/dirty.ts";
import { nextPoints, parsePoints } from "./agent/task-edit.ts";
import { scorePlannerGraph } from "./eval/rubric.ts";
import type { PlannerSession } from "./agent/session.ts";
import type { SolutionPlanner } from "./workspace.types.ts";
import type { CollabSession } from "@collabnode/runtime";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: join(root, ".env") });
for (const key of [
  "AZURE_OPENAI_API_KEY",
  "AZURE_AI_FOUNDRY_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
]) {
  delete process.env[key];
}

function planner(ws: { session: CollabSession }): PlannerSession {
  return ws.session.as<SolutionPlanner>();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertProviderSelection(): void {
  process.env.LLM_PROVIDER = "azure";
  process.env.GOOGLE_API_KEY = "ambient-gemini-key";
  if (getChatModel() !== null) {
    throw new Error("LLM_PROVIDER=azure with no Azure credentials must not fall through to Gemini");
  }
  process.env.LLM_PROVIDER = "gemini";
  const gemini = getChatModel();
  if (!gemini || !gemini.constructor.name.includes("Google")) {
    throw new Error(`LLM_PROVIDER=gemini should build a Gemini model, got ${gemini?.constructor.name}`);
  }
  delete process.env.LLM_PROVIDER;
  delete process.env.GOOGLE_API_KEY;
  console.log("✓ LLM_PROVIDER is honoured for every provider");
}

function assertPointStepper(): void {
  assert(parsePoints("not a number", 3) === 3, "prose points fall back");
  assert(parsePoints(8) === 8, "integer points pass through");
  assert(nextPoints(3) === 5, "Fibonacci stepper");
  console.log("✓ Point stepper keeps Fibonacci as UI convention");
}

async function withPlanner<T>(fn: (session: PlannerSession, type: Awaited<ReturnType<typeof loadWorkspaceTypeFile>>) => Promise<T>): Promise<T> {
  const { backend, close } = await openCollab({ kind: "memory" }, "server");
  const hub = await createHub({ collab: backend, sweepIntervalMs: 0 });
  const type = await loadWorkspaceTypeFile(join(root, "workspaces/solution-planner.yaml"));
  hub.define(type);
  const ws = await hub.open("solution-planner", {
    id: `test-${Date.now().toString(36)}`,
    actorId: "server",
    params: { appName: "Test", language: "en" },
  });
  try {
    return await fn(planner(ws), type);
  } finally {
    await hub.close();
    await close?.();
  }
}

async function assertCrewToolPolicy(): Promise<void> {
  await withPlanner(async (session, workspaceType) => {
    const manager = getDeepAgentConfig({
      session: session.as(),
      workspaceType,
      role: "manager",
      language: "en",
    });
    const architect = createSubAgentConfig({
      session: session.as(),
      workspaceType,
      role: "architect",
      language: "en",
    });

    const managerTools = manager.tools.map((t) => t.name);
    const architectTools = architect.tools.map((t) => t.name);

    assert(managerTools.includes("upsert_node_Epic"), "manager writes Epics");
    assert(managerTools.includes("upsert_node_Feature"), "manager writes Features");
    assert(!managerTools.includes("upsert_node_Task"), "manager cannot write Tasks");
    assert(!managerTools.includes("upsert_node_C4DiagramElement"), "manager cannot write C4");
    assert(managerTools.includes("view_solution_view"), "manager has solution_view");

    assert(architectTools.includes("upsert_node_Task"), "architect writes Tasks");
    assert(architectTools.includes("upsert_node_C4DiagramElement"), "architect writes C4");
    assert(!architectTools.includes("upsert_node_Epic"), "architect cannot write Epics");
    assert(!architectTools.includes("upsert_node_Feature"), "architect cannot write Features");
    assert(architectTools.includes("view_solution_view"), "architect has solution_view");

    assert(architect.name === "architect", "subagent is named architect");
    console.log("✓ Manager and Architect tool surfaces match the YAML split");
  });
}

async function assertDirtyCascade(): Promise<void> {
  await withPlanner(async (session) => {
    const epicId = await session.upsertNode({
      type: "Epic",
      properties: { title: "Auth", description: "Sign in" },
    });
    const featureId = await session.upsertNode({
      type: "Feature",
      properties: { title: "Login" },
    });
    await session.upsertEdge({ type: "HAS_FEATURE", from: epicId, to: featureId });

    await markDirtyAndCascade(session, epicId);
    const dirty = dirtyNodes(session.snapshot()).map((n) => n.id);
    assert(dirty.includes(epicId), "epic marked dirty");
    assert(dirty.includes(featureId), "feature cascaded dirty");
    const state = session.snapshot().nodes.find((n) => n.type === "SolutionState");
    assert(state?.properties.managerAgrees !== true, "human edit breaks manager agreement");
    console.log("✓ Dirty cascade walks HAS_FEATURE and clears consensus");
  });
}

async function assertMermaidFromC4(): Promise<void> {
  await withPlanner(async (session) => {
    const person = await session.upsertNode({
      type: "C4DiagramElement",
      properties: { title: "User", type: "Person", description: "A person" },
    });
    const system = await session.upsertNode({
      type: "C4DiagramElement",
      properties: { title: "Portal", type: "System", description: "The app" },
    });
    await session.upsertEdge({ type: "USES", from: person, to: system });
    const dsl = snapshotToMermaid(session.as().snapshot(), session.schema, { kind: "c4" });
    assert(/C4Context|Person|System/.test(dsl), `expected C4 mermaid, got ${dsl.slice(0, 200)}`);
    console.log("✓ C4 nodes compile to Mermaid");
  });
}

function assertRubric(): void {
  const empty = scorePlannerGraph({ nodes: [], edges: [] }, []);
  assert(empty.score === 0.1, `empty graph only earns clean_finish (0.1), got ${empty.score}`);
  assert(empty.failures.length === 6, `expected 6 failed checks, got ${empty.failures.length}`);

  const epic = { id: "e1", type: "Epic", properties: { title: "Portal" } };
  const f1 = { id: "f1", type: "Feature", properties: { title: "Upload" } };
  const f2 = { id: "f2", type: "Feature", properties: { title: "Search" } };
  const tasks = [1, 2, 3].map((n) => ({
    id: `t${n}`,
    type: "Task",
    properties: { title: `Task ${n}`, description: "What: ship it\nHow: Azure" },
  }));
  const c4 = [
    { id: "p1", type: "C4DiagramElement", properties: { type: "Person", title: "User" } },
    { id: "b1", type: "C4DiagramElement", properties: { type: "Boundary", title: "Portal" } },
    { id: "c1", type: "C4DiagramElement", properties: { type: "Container", title: "SPA" } },
    { id: "c2", type: "C4DiagramElement", properties: { type: "Container", title: "API" } },
    {
      id: "s1",
      type: "C4DiagramElement",
      properties: { type: "System", title: "Microsoft Entra ID", external: true },
    },
    {
      id: "s2",
      type: "C4DiagramElement",
      properties: { type: "System", title: "Azure Cosmos DB", external: true },
    },
    {
      id: "s3",
      type: "C4DiagramElement",
      properties: { type: "System", title: "Application Insights", external: true },
    },
  ];
  const risks = [
    { id: "r1", type: "Risk", properties: { title: "Scope", category: "business" } },
    { id: "r2", type: "Risk", properties: { title: "Latency", category: "technical" } },
  ];
  const edges = [
    { id: "hf1", type: "HAS_FEATURE", from: "e1", to: "f1" },
    { id: "hf2", type: "HAS_FEATURE", from: "e1", to: "f2" },
    { id: "ht1", type: "HAS_TASK", from: "f1", to: "t1" },
    { id: "ht2", type: "HAS_TASK", from: "f1", to: "t2" },
    { id: "ht3", type: "HAS_TASK", from: "f2", to: "t3" },
  ];
  const logs = [
    { actor: "manager" as const, text: "🔧 view_solution_view", at: "" },
    { actor: "manager" as const, text: "🔧 upsert_node_Epic", at: "" },
    { actor: "manager" as const, text: "🔧 task {\"name\":\"architect\"}", at: "" },
  ];
  const good = scorePlannerGraph(
    { nodes: [epic, f1, f2, ...tasks, ...c4, ...risks], edges },
    logs,
  );
  assert(good.score === 1, `complete graph should score 1, got ${good.score} ${good.failures.join("; ")}`);
  console.log("✓ Graph rubric scores empty vs complete fixtures");
}

async function run(): Promise<void> {
  console.log("▶ Solution Planner Deep Agents contract tests");
  assertProviderSelection();
  assertPointStepper();
  assertRubric();
  await assertCrewToolPolicy();
  await assertDirtyCascade();
  await assertMermaidFromC4();
  console.log("🎉 All Solution Planner tests passed successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

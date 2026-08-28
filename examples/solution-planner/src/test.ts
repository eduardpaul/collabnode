import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  descriptionHasWhatAndHow,
  isPoint,
  normalizeTaskProperties,
  parsePoints,
} from "./agent/schemas.ts";
import {
  expandCombinedC4Models,
  extractC4Boxes,
  isCombinedC4Diagram,
  missingC4Levels,
  splitCombinedC4Plan,
} from "./agent/c4.ts";
import { getChatModel } from "./agent/llm.ts";
import { readOnlyTools } from "@collabnode/deepagents";
import { applyPlan, emptyPlan, plannerPlanSchema } from "./agent/plan.ts";
import { getDeepAgentConfig } from "@collabnode/deepagents";
import { snapshotToMermaid } from "./mermaid/dsl.ts";
import type { CollabSession } from "@collabnode/runtime";
import { nodeOfType, nodesOfType, type PlannerSession } from "./agent/session.ts";
import type { SolutionPlanner } from "./workspace.types.ts";
import type { WorkspaceType } from "collabnode";

import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: join(root, ".env") });
// Graph-protocol tests must stay deterministic. Live Foundry + MCP is `pnpm test:llm`.
for (const key of [
  "AZURE_OPENAI_API_KEY",
  "AZURE_AI_FOUNDRY_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
]) {
  delete process.env[key];
}

function assertPartialWritesStayPartial(): void {
  // A partial write must stay partial: an upsert merges over what is stored, so
  // injecting defaults for absent keys would blank the description and reset
  // both estimates on a rename.
  const renameOnly = normalizeTaskProperties(
    { title: "Renamed task" },
    { language: "en" },
  );
  if (
    "description" in renameOnly ||
    "functionalPoints" in renameOnly ||
    "technicalPoints" in renameOnly
  ) {
    throw new Error(
      `normalizeTaskProperties must not invent absent keys, got ${JSON.stringify(renameOnly)}`,
    );
  }
  const untouched = { title: "T", description: "What: a\nHow: b\n", functionalPoints: 5 };
  const passthrough = normalizeTaskProperties({ ...untouched }, { language: "en" });
  if (passthrough.description !== untouched.description || passthrough.functionalPoints !== 5) {
    throw new Error(`normalizeTaskProperties rewrote an already-clean task: ${JSON.stringify(passthrough)}`);
  }
  console.log("✓ normalizeTaskProperties leaves absent and already-clean fields alone");
}

function assertProviderSelection(): void {
  // LLM_PROVIDER names the provider outright; an ambient key for another one
  // must not override it, in either direction.
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

function assertNoEmptyBoundary(): void {
  // Mermaid's C4 grammar has no empty-boundary production; `{ }` is a parse
  // error that replaces the whole diagram with an error box.
  const lonelyBoundary = snapshotToMermaid(
    {
      schemaId: "solution-planner",
      schemaHash: "x",
      nodes: [
        { id: "b", type: "C4DiagramElement", properties: { type: "Boundary", title: "Empty" }, meta: {} },
        { id: "s", type: "C4DiagramElement", properties: { type: "System", title: "Portal" }, meta: {} },
      ],
      edges: [],
    },
    undefined,
    { kind: "c4" },
  );
  if (/\{\s*\}/.test(lonelyBoundary) || lonelyBoundary.includes("System_Boundary(")) {
    throw new Error(`childless Boundary must not emit an empty block:\n${lonelyBoundary}`);
  }
  console.log("✓ A Boundary with no children never emits an unparseable empty block");
}

function assertPackedC4Splits(): void {
  // Every packed box becomes an element, whatever the packed node's own type.
  const packedBoundary = splitCombinedC4Plan([
    {
      type: "Boundary",
      title: "Platform",
      description: "UI[React Frontend]\n  Hub[Collabnode Hub]\n  Redis[(Redis Registry)]",
    },
  ]);
  const spawned = packedBoundary.filter((el) => el.type === "Container").map((el) => el.title);
  if (packedBoundary.length !== 4 || spawned.length !== 3) {
    const got = packedBoundary.map((e) => `${e.type}:${e.title}`).join(", ");
    throw new Error(`packed Boundary should keep itself + 3 containers, got ${got}`);
  }
  console.log("✓ Packed C4 elements split into one element each");
}

/**
 * A plan that is all Containers is the failure this reports: a model asked for
 * "a C4 model" answers with a container diagram — no actor, no external system,
 * no component — and the board shows a boundary of boxes with nothing around it.
 */
function assertC4CoverageIsReported(): void {
  const containersOnly = [
    { type: "Boundary" },
    { type: "Container" },
    { type: "Container" },
  ];
  const missing = missingC4Levels(containersOnly);
  if (!missing.includes("Person") || !missing.includes("System") || !missing.includes("Component")) {
    throw new Error(`container-only C4 must report its gaps, got ${JSON.stringify(missing)}`);
  }
  const full = [
    { type: "Person" },
    { type: "System" },
    { type: "Boundary" },
    { type: "Container" },
    { type: "Component" },
  ];
  if (missingC4Levels(full).length !== 0) {
    throw new Error(`a complete C4 model reports no gap, got ${JSON.stringify(missingC4Levels(full))}`);
  }
  console.log("✓ A container-only C4 model reports the levels it is missing");
}

/**
 * The plan schema is derived from the workspace YAML, so a property that gains
 * an enum value or a guideline reaches the model without a second copy of the
 * schema being edited to match — and there is nowhere in it to name a parent by
 * title.
 */
async function assertPlanSchemaComesFromYaml(): Promise<void> {
  const architect = await plannerPlanSchema("architect", "en");
  const asJsonSchema = z.toJSONSchema(architect, { io: "input" }) as {
    properties?: Record<string, unknown>;
  };
  // Read off the JSON Schema rather than the Zod object: this is what the model
  // is actually handed, and `planEnvelope` returns the plan type, not a shape.
  const keys = Object.keys(asJsonSchema.properties ?? {});
  for (const key of ["nodes", "edges", "removeEdges", "agrees", "review"]) {
    if (!keys.includes(key)) {
      throw new Error(`plan schema is missing '${key}'`);
    }
  }
  // Key order is prompt order: the model writes its reasoning before the plan
  // and judges it after.
  if (keys[0] !== "review" || keys.indexOf("agrees") < keys.indexOf("nodes")) {
    throw new Error(`plan schema asks its questions out of order: ${keys.join(", ")}`);
  }

  const json = JSON.stringify(asJsonSchema);
  for (const banned of ["parentTitle", "featureRef", "c4Ref", "threatensRef", "relatesToRef"]) {
    if (json.includes(banned)) {
      throw new Error(`plan schema still carries a title-based handle: ${banned}`);
    }
  }
  // Straight out of the YAML: the C4 kinds and the guideline written next to them.
  for (const expected of ["Boundary", "Component", "container diagram alone is not a C4 model"]) {
    if (!json.includes(expected)) {
      throw new Error(`plan schema lost '${expected}' from the workspace YAML`);
    }
  }
  // Bounds live in the description, never as keywords strict json_schema rejects.
  if (json.includes('"maximum":21') || json.includes('"minimum":1')) {
    throw new Error("plan schema leaks declared bounds that strict json_schema rejects");
  }
  console.log("✓ The plan schema is generated from the workspace YAML, with no title handles");
}

/** Endpoints resolve as a plan ref or a live id — and as nothing else. */
async function assertPlanResolvesByRefAndId(session: PlannerSession): Promise<void> {
  const epicId = await session.upsertNode(
    { type: "Epic", properties: { title: "Existing Epic" } },
    { actorId: "system" },
  );

  const plan = emptyPlan();
  plan.nodes.push({ type: "Feature", ref: "f1", properties: { title: "Born in this plan" } });
  plan.nodes.push({ type: "Risk", ref: "r1", properties: { title: "Linked to a live node", severity: "low" } });
  // ref → node created in the same batch; id → node already in the graph.
  plan.edges.push({ type: "HAS_FEATURE", from: epicId, to: "f1" });
  plan.edges.push({ type: "HAS_RISK", from: epicId, to: "r1" });
  // A title is not a handle: this one resolves to nothing and is reported.
  plan.edges.push({ type: "HAS_FEATURE", from: "Existing Epic", to: "f1" });

  const written = await applyPlan(session, plan, { actorId: "ai-manager", language: "en" });
  if (written.droppedEdges.length !== 1) {
    throw new Error(`a title endpoint must be dropped and reported, got ${JSON.stringify(written.droppedEdges)}`);
  }

  const snapshot = session.snapshot();
  const featureId = written.idsByRef.f1;
  const hasFeature = snapshot.edges.some(
    (e) => e.type === "HAS_FEATURE" && e.from === epicId && e.to === featureId,
  );
  const hasRisk = snapshot.edges.some(
    (e) => e.type === "HAS_RISK" && e.from === epicId && e.to === written.idsByRef.r1,
  );
  if (!hasFeature || !hasRisk) {
    throw new Error("plan edges must land on the ids the batch created");
  }
  // The Manager stamps the category; the model is not asked for it.
  const risk = nodeOfType(snapshot, "Risk", written.idsByRef.r1);
  if (risk?.properties.dirty !== false) {
    throw new Error("a plan write is never dirty");
  }

  // The same node again, this time by id: an update, not a second node.
  const rename = emptyPlan();
  rename.nodes.push({ type: "Feature", ref: "f1", id: featureId, properties: { title: "Renamed by id" } });
  await applyPlan(session, rename, { actorId: "ai-manager", language: "en" });
  const features = nodesOfType(session.snapshot(), "Feature");
  if (features.length !== 1 || features[0]!.properties.title !== "Renamed by id") {
    throw new Error(`an entry with an id updates that node, got ${JSON.stringify(features.map((f) => f.properties.title))}`);
  }
  console.log("✓ Plan endpoints resolve by ref or id; a title resolves to nothing");
}

/** The crew reads while composing; every write lands in the one batch, within policy. */
function assertComposingIsReadOnly(session: CollabSession, type: WorkspaceType): void {
  // The plan is written once, by the batch. While the crew is *composing* it,
  // only queries and docs are on the table — a second live write path would
  // race the batch and one of the two would silently win.
  for (const role of ["manager", "architect"] as const) {
    const config = getDeepAgentConfig({ session, workspaceType: type, role });
    if (config.tools.length === 0) {
      throw new Error(`${role} got no schema tools at all — check tools.expose in the workspace yaml`);
    }
    const composing = readOnlyTools(config.tools).map((t) => t.name);
    const writes = composing.filter((name) => /(^|_)(upsert|delete|apply_batch)(_|$)/.test(name));
    if (writes.length > 0) {
      throw new Error(`${role} could write while composing a plan: ${writes.join(", ")}`);
    }
    if (!composing.includes("graph_search") || !composing.includes("graph_list")) {
      throw new Error(`${role} lost its read tools: ${composing.join(", ")}`);
    }
  }
  // The workspace policy is real, not decorative.
  const managerTools = getDeepAgentConfig({ session, workspaceType: type, role: "manager" })
    .tools.map((t) => t.name);
  if (managerTools.includes("upsert_node_Task") || managerTools.includes("upsert_node_C4DiagramElement")) {
    throw new Error("nodes.readOnly is not being enforced: manager can write the architect's types");
  }
  console.log("✓ Crew reads while composing; writes land only in the batch, within policy");
}

function assertPointCoercion(): void {
  const coerced = normalizeTaskProperties(
    {
      title: "Wire auth",
      description: "Implement login",
      functionalPoints: "User can sign in with Entra ID",
      technicalPoints: "Easy Auth on Container Apps",
      complexity: 2,
    },
    { language: "en" },
  );
  if (!isPoint(coerced.functionalPoints) || !isPoint(coerced.technicalPoints)) {
    throw new Error("normalizeTaskProperties must store a storable point number, not prose");
  }
  if (!descriptionHasWhatAndHow(String(coerced.description))) {
    throw new Error("prose from point fields must move into description as What/How");
  }
  // The only requirement is a number the schema will store: integer, 1-21.
  // An off-ladder estimate is fine and must survive untouched.
  const points: Array<[unknown, number]> = [
    ["8", 8],
    [4, 4], // not on the Fibonacci ladder, and that is not a problem
    [3.7, 4],
    [0, 1],
    [99, 21],
    ["User journey", 3],
    [undefined, 3],
  ];
  for (const [input, expected] of points) {
    if (parsePoints(input) !== expected) {
      throw new Error(`parsePoints(${JSON.stringify(input)}) should be ${expected}, got ${parsePoints(input)}`);
    }
  }
  console.log("✓ Prose in point fields moves into What/How; any storable integer is kept as-is");
}

function assertCombinedMermaidSplits(): void {
    const mermaidDump = `\`\`\`mermaid
  flowchart TD
    User([👤 User / Browser])
    UI[React Frontend]
    Hub[Collabnode Hub]
    Redis[(Redis Registry)]
  \`\`\``;
    const boxes = extractC4Boxes(mermaidDump);
    if (boxes.containers.length < 3 || !isCombinedC4Diagram(mermaidDump)) {
      throw new Error(`expected mermaid dump to contain multiple containers, got ${JSON.stringify(boxes)}`);
    }
    const split = expandCombinedC4Models([{ title: "C4 Container Diagram", level: "container", markdown: mermaidDump }]);
    if (split.length < 3 || split.some((el) => isCombinedC4Diagram(el.markdown))) {
      throw new Error(`expected split C4 nodes, got ${JSON.stringify(split.map((s) => s.title))}`);
    }
    console.log("✓ Combined C4 mermaid splits into one node per container");
}

function assertC4CompilesToMermaid(): void {
  const mermaidDsl = snapshotToMermaid(
    {
      schemaId: "solution-planner",
      schemaHash: "x",
      nodes: [
        { id: "p", type: "C4DiagramElement", properties: { type: "Person", title: "User" }, meta: {} },
        { id: "s", type: "C4DiagramElement", properties: { type: "System", title: "Portal" }, meta: {} },
        { id: "sx", type: "C4DiagramElement", properties: { type: "System", title: "Microsoft Learn", external: true }, meta: {} },
        { id: "b", type: "C4DiagramElement", properties: { type: "Boundary", title: "Portal" }, meta: {} },
        { id: "c1", type: "C4DiagramElement", properties: { type: "Container", title: "React SPA" }, meta: {} },
        { id: "c2", type: "C4DiagramElement", properties: { type: "Container", title: "Redis" }, meta: {} },
        { id: "c3", type: "C4DiagramElement", properties: { type: "Container", title: "CDN", external: true }, meta: {} },
      ],
      edges: [
        { id: "e1", type: "CONTAINS", from: "b", to: "c1", properties: {}, meta: {} },
        { id: "e2", type: "CONTAINS", from: "b", to: "c2", properties: {}, meta: {} },
        { id: "e3", type: "USES", from: "p", to: "c1", properties: {}, meta: {} },
      ],
    },
    undefined,
    { kind: "c4" },
  );
  if (
    !mermaidDsl.startsWith("C4Container") ||
    !mermaidDsl.includes("Person(") ||
    !mermaidDsl.includes("System(") ||
    !mermaidDsl.includes("System_Ext(") ||
    !mermaidDsl.includes("System_Boundary(") ||
    !mermaidDsl.includes("Container(") ||
    !mermaidDsl.includes("ContainerDb(") ||
    !mermaidDsl.includes("Container_Ext(") ||
    !mermaidDsl.includes("Rel(")
  ) {
    throw new Error(`expected Mermaid C4 with _Ext for external nodes, got:\n${mermaidDsl}`);
  }
  console.log("✓ Snapshot C4 nodes compile to Mermaid C4 DSL with _Ext variants");
}

async function runTest() {
  console.log("▶ Testing Solution Planner End-to-End...");

  assertPartialWritesStayPartial();
  assertProviderSelection();
  assertNoEmptyBoundary();
  assertPackedC4Splits();
  assertC4CoverageIsReported();
  assertPointCoercion();
  assertCombinedMermaidSplits();
  assertC4CompilesToMermaid();
  await assertPlanSchemaComesFromYaml();

  // 1. Open collab session (in-memory)
  const { backend, close } = await openCollab({ kind: "memory" }, "server");
  const hub = await createHub({ collab: backend, sweepIntervalMs: 0 });

  const type = await loadWorkspaceTypeFile(join(root, "workspaces/solution-planner.yaml"));
  hub.define(type);

  const ws = await hub.open("solution-planner", {
    id: "test-planner-1",
    actorId: "server",
    params: { appName: "Notion Clone Test", language: "en" },
  });

  console.log("✓ Workspace opened successfully with ID:", ws.id);

  assertComposingIsReadOnly(ws.session, type);

  // Its own workspace: this one is about how a plan lands, kept separate from
  // the workspace the rest of the file opens.
  const planWs = await hub.open("solution-planner", {
    id: "test-plan-writes",
    actorId: "server",
    params: { appName: "Plan Writes", language: "en" },
  });
  await assertPlanResolvesByRefAndId(planWs.session.as<SolutionPlanner>());

  // The end-to-end agent chain that used to run here (Manager turn,
  // assumption pause, Architect turn, dirty cascade, revision loop) asserted
  // on nodes that only the deterministic fallback produced when no model is
  // configured. That fallback is gone, so the chain was asserting on
  // fabricated data rather than on agent behaviour. Covering it again needs a
  // stub model driving the agents; see test-llm-planner.ts for the live-model run.

  await hub.close();
  await close?.();

  console.log("🎉 All Solution Planner tests passed successfully!");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

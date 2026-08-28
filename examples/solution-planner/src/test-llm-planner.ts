import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { HumanMessage } from "@langchain/core/messages";
import {
  startPlannerWorkflow,
  startRevisionWorkflow,
  resumePlannerWithValidation,
} from "./agent/graph.ts";
import { dirtyNodes, markDirtyAndCascade } from "./agent/dirty.ts";
import { nodeOfType, nodesOfType, type PlannerSession } from "./agent/session.ts";
import type { SolutionPlanner } from "./workspace.types.ts";
import type { CollabSession } from "@collabnode/runtime";
import { isCombinedC4Diagram } from "./agent/c4.ts";
import { getChatModel } from "./agent/llm.ts";
import { loadMicrosoftLearnTools } from "./agent/microsoft-learn.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: join(root, ".env") });

const SOLUTION = [
  "Customer document portal on Azure.",
  "React SPA uploads files to an Azure Container Apps API.",
  "Authenticate users with Azure Container Apps Easy Auth (Microsoft Entra ID).",
  "Store metadata in Azure Cosmos DB and traces in Azure Application Insights.",
].join(" ");

const FALLBACK_TASK_TITLES = new Set([
  "Implement useCollab React Hook Binding",
  "Configure Hub Server with Fluid & Redis",
  "Build Cyclic LangGraph Multi-Agent Workflow",
]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** The hub is schema-agnostic; this puts the planner's own types back on. */
function planner(ws: { session: CollabSession }): PlannerSession {
  return ws.session.as<SolutionPlanner>();
}

async function requireLiveLlm() {
  const model = getChatModel();
  assert(model, "LLM is required: set GEMINI_API_KEY, AZURE_OPENAI_API_KEY, or OPENAI_API_KEY in .env");
  const ping = await model.invoke([new HumanMessage("Reply with exactly: PONG")]);
  const text = typeof ping.content === "string" ? ping.content : JSON.stringify(ping.content);
  assert(/pong/i.test(text), `LLM ping failed, got: ${text.slice(0, 200)}`);
  const modelName =
    process.env.GEMINI_MODEL ??
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??
    process.env.OPENAI_MODEL ??
    "live-llm";
  console.log(`✓ Live LLM connected (${modelName})`);
  return model;
}

async function requireLearnMcp() {
  const flag = process.env.MICROSOFT_LEARN_MCP?.trim().toLowerCase();
  assert(flag !== "0" && flag !== "false" && flag !== "off", "MICROSOFT_LEARN_MCP is disabled");
  const learn = await loadMicrosoftLearnTools();
  const names = learn.tools.map((t) => t.name);
  assert(learn.tools.length > 0, "Microsoft Learn MCP returned no tools");
  assert(
    names.includes("microsoft_docs_search"),
    `expected microsoft_docs_search, got ${names.join(", ")}`,
  );
  console.log(`✓ Microsoft Learn MCP: ${learn.serverName} (${names.join(", ")})`);
  return learn;
}

async function testPlannerJourneyWithLlm(): Promise<void> {
  console.log("▶ Full planner journey with Foundry LLM");

  const { backend, close } = await openCollab({ kind: "memory" }, "server");
  const hub = await createHub({ collab: backend, sweepIntervalMs: 0 });
  const type = await loadWorkspaceTypeFile(join(root, "workspaces/solution-planner.yaml"));
  hub.define(type);

  const ws = await hub.open("solution-planner", {
    id: "test-llm-planner-1",
    actorId: "server",
    params: { appName: "Azure Document Portal", language: "en" },
  });

  try {
    let state = await startPlannerWorkflow(ws.id, planner(ws), SOLUTION, "en");
    console.log("  after start:", {
      status: state.status,
      iteration: state.iteration,
      assumption: Boolean(state.activeAssumptionId),
    });

    if (state.status === "waiting_user_validation") {
      assert(state.activeAssumptionId, "HITL pause without assumption id");
      state = await resumePlannerWithValidation(ws.id, planner(ws), {
        assumptionId: state.activeAssumptionId,
        approved: true,
        comment: "Approved Entra ID Easy Auth + Cosmos DB on Container Apps",
      });
      console.log("  after HITL resume:", { status: state.status });
    }

    assert(
      state.status === "approved" && state.managerAgrees && state.architectAgrees,
      `expected approved consensus after LLM planning, got status=${state.status}`,
    );

    const snap = planner(ws).snapshot();
    const epics = nodesOfType(snap, "Epic");
    const features = nodesOfType(snap, "Feature");
    const tasks = nodesOfType(snap, "Task");
    const c4 = nodesOfType(snap, "C4DiagramElement");
    const risks = nodesOfType(snap, "Risk");

    assert(epics.length >= 1, "LLM manager should create Epics");
    assert(features.length >= 1, "LLM manager should create Features");
    assert(c4.length >= 2, "LLM architect should create C4 Person/System/Boundary/Container nodes");
    // `description` is the only prose a C4DiagramElement carries — the
    // `markdown` fallback this used to check named a property the schema has
    // never declared, so it read as undefined every time.
    const packedC4 = c4.filter((n) => isCombinedC4Diagram(n.properties.description));
    assert(packedC4.length === 0, "C4 nodes must not pack multiple containers into one mermaid diagram");
    assert(tasks.length >= 1, "LLM architect should create Tasks");
    assert(risks.length >= 1, "expected at least one Risk");

    const fallbackHits = tasks.filter((t) =>
      FALLBACK_TASK_TITLES.has(String(t.properties.title ?? "")),
    );
    assert(
      fallbackHits.length === 0,
      `Architect used deterministic fallback tasks: ${fallbackHits
        .map((t) => t.properties.title)
        .join(", ")}`,
    );

    const graphBlob = snap.nodes
      .map((n) => Object.values(n.properties).map((v) => String(v ?? "")).join(" "))
      .join("\n")
      .toLowerCase();
    assert(
      /azure|entra|cosmos|container apps|easy auth/.test(graphBlob),
      "LLM plan should mention Azure/Entra/Cosmos/Container Apps rather than the Collabnode fallback",
    );

    for (const task of tasks) {
      const title = task.properties.title;
      assert(
        typeof task.properties.functionalPoints === "number",
        `task ${title} missing numeric functionalPoints`,
      );
      assert(
        typeof task.properties.technicalPoints === "number",
        `task ${title} missing numeric technicalPoints`,
      );
      assert(
        [1, 2, 3, 5, 8, 13, 21].includes(task.properties.functionalPoints as number),
        `task ${title} functionalPoints must be Fibonacci`,
      );
      assert(
        [1, 2, 3, 5, 8, 13, 21].includes(task.properties.technicalPoints as number),
        `task ${title} technicalPoints must be Fibonacci`,
      );
      assert(task.properties.complexity !== undefined, `task ${title} missing complexity`);
      // Task has no `status` in the schema, so there is nothing left to assert:
      // the generated types make writing one a compile error, and the runtime
      // rejects it as an unknown property.
      const desc = String(task.properties.description ?? "").toLowerCase();
      assert(
        (desc.includes("what:") || desc.includes("qué:")) &&
          (desc.includes("how:") || desc.includes("cómo:")),
        `task ${title} description must include What and How`,
      );
    }

    console.log("✓ LLM initial plan graph:", {
      epics: epics.length,
      features: features.length,
      c4: c4.length,
      tasks: tasks.length,
      risks: risks.length,
      sampleTask: tasks[0]?.properties.title,
    });

    console.log("▶ User action 1: Editing existing Epic...");
    const epic = epics[0]!;
    await planner(ws).upsertNode(
      {
        id: epic.id,
        type: "Epic",
        properties: {
          ...epic.properties,
          description:
            "Narrowed: Easy Auth only (Entra ID). No custom JWT middleware. Keep Cosmos DB and Blob Storage.",
        },
      },
      { actorId: "human-user" },
    );
    await markDirtyAndCascade(planner(ws), epic.id);

    console.log("▶ User action 2: Adding a brand new Feature node to the graph...");
    const userFeatureId = await planner(ws).upsertNode(
      {
        type: "Feature",
        properties: {
          title: "Direct Azure Blob Storage Chunked Upload",
          description:
            "Allow client SPA to upload large files directly to Azure Blob Storage using SAS tokens generated by Container Apps API.",
          dirty: true,
        },
      },
      { actorId: "human-user" },
    );
    await planner(ws).upsertEdge(
      {
        type: "HAS_FEATURE",
        from: epic.id,
        to: userFeatureId,
      },
      { actorId: "human-user" },
    );

    const dirtyBefore = dirtyNodes(planner(ws).snapshot());
    console.log(`  dirty nodes before revision: ${dirtyBefore.length} (including user-created Feature: ${userFeatureId})`);
    assert(dirtyBefore.length > 0, "edited Epic and new Feature should be dirty before revision");

    const reviewMessage =
      "I edited the auth epic to Easy Auth only, and added a NEW Feature for Direct Azure Blob Storage Chunked Upload with SAS tokens. Please break down tasks with Fibonacci functional/technical points and What/How in the description.";

    console.log("▶ Triggering Crew Revision Workflow with live LLM...");
    let revised = await startRevisionWorkflow(ws.id, planner(ws), reviewMessage);
    if (revised.status === "waiting_user_validation" && revised.activeAssumptionId) {
      revised = await resumePlannerWithValidation(ws.id, planner(ws), {
        assumptionId: revised.activeAssumptionId,
        approved: true,
        comment: "Approved Easy Auth and Blob Storage SAS upload revision",
      });
    }

    assert(
      revised.status === "approved" && revised.managerAgrees && revised.architectAgrees,
      `expected approved consensus after LLM revision, got status=${revised.status}`,
    );

    const snapAfter = planner(ws).snapshot();
    const leftover = dirtyNodes(snapAfter);
    assert(leftover.length === 0, `dirty flags should clear after LLM revision, found ${leftover.length}`);
    assert(
      revised.logs.some((log) => log.actor === "user" && log.text.includes(reviewMessage)),
      "revision log should include the user review note",
    );

    // Verify user-created feature exists in final graph (by ID or title)
    const persistedUserFeature =
      nodeOfType(snapAfter, "Feature", userFeatureId) ??
      nodesOfType(snapAfter, "Feature").find((n) =>
        /direct azure blob/i.test(n.properties.title),
      );
    assert(persistedUserFeature, "User-added Feature must persist in the graph");
    assert(
      persistedUserFeature.properties.dirty !== true,
      "User-added Feature dirty flag must be cleared after crew revision",
    );

    console.log(
      `✓ LLM revision journey passed: ${dirtyBefore.length} dirty → 0, user-created node preserved & integrated, status=${revised.status}`,
    );
  } finally {
    await hub.close();
    await close?.();
  }
}

async function run() {
  console.log("▶ Functional LLM test: structured-output planner journey");
  console.log("  endpoint:", process.env.AZURE_OPENAI_ENDPOINT);
  console.log("  mcp:", process.env.MICROSOFT_LEARN_MCP_URL ?? "(default)");

  await requireLiveLlm();
  const learn = await requireLearnMcp();
  try {
    await testPlannerJourneyWithLlm();
  } finally {
    await learn.close();
  }

  console.log("🎉 Functional LLM planner journey passed");
}

run().catch((err) => {
  console.error("Functional LLM test failed:", err);
  process.exit(1);
});

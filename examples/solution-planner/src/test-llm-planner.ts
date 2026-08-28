import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
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
import { invokeStructured, type ToolEvent } from "@collabnode/deepagents";
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

const LEARN_TOOL_NAMES = new Set([
  "microsoft_docs_search",
  "microsoft_docs_fetch",
  "microsoft_code_sample_search",
]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function logLines(title: string, lines: string[]): void {
  console.log(`  ${title}`);
  for (const line of lines.slice(0, 12)) {
    console.log(`    • ${line}`);
  }
  if (lines.length > 12) {
    console.log(`    … ${lines.length - 12} more`);
  }
}

function architectLearnLogs(logs: Array<{ actor: string; text: string }>): string[] {
  return logs
    .filter((log) => log.actor === "architect")
    .map((log) => log.text)
    .filter(
      (text) =>
        text.includes("Microsoft Learn") ||
        text.includes("📚") ||
        /Connected to .*MCP/i.test(text),
    );
}

function usedArchitectTools(logs: Array<{ actor: string; text: string }>): boolean {
  return logs.some(
    (log) =>
      log.actor === "architect" &&
      (log.text.includes("📚 Microsoft Learn") || log.text.includes("🔧 [architect]")),
  );
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

async function testDirectArchitectToolLoop(
  model: NonNullable<ReturnType<typeof getChatModel>>,
  learn: Awaited<ReturnType<typeof loadMicrosoftLearnTools>>,
): Promise<void> {
  console.log("▶ Direct Architect invoke: LLM must call Learn MCP before structured output");

  const events: ToolEvent[] = [];
  const schema = z.object({
    officialTitle: z.string(),
    learnUrl: z.string(),
    takeaway: z.string(),
  });

  const parsed = await invokeStructured(
    model,
    schema,
    [
      "Look up Azure Container Apps built-in authentication (Easy Auth) on Microsoft Learn.",
      "You MUST call microsoft_docs_search (and microsoft_docs_fetch if excerpts are thin) before answering.",
      "Do not rely on training data.",
    ].join(" "),
    "learn_grounding",
    {
      tools: learn.tools,
      system:
        "You are an AI Software Architect. Use Microsoft Learn MCP tools while you work. Search, then answer.",
      maxToolRounds: 6,
      onToolEvent: (event) => {
        events.push(event);
        console.log(`  📚 ${event.name}: ${JSON.stringify(event.args).slice(0, 160)}`);
      },
    },
  );

  const learnToolCalls = events.filter((e) => LEARN_TOOL_NAMES.has(e.name));
  assert(
    learnToolCalls.length > 0,
    "LLM did not call any Microsoft Learn MCP tool while composing the answer",
  );
  assert(parsed.officialTitle.trim().length > 0, "structured officialTitle missing");
  assert(
    /learn\.microsoft\.com/i.test(parsed.learnUrl),
    `expected a learn.microsoft.com URL, got ${parsed.learnUrl}`,
  );
  assert(parsed.takeaway.trim().length > 20, "takeaway too short to be grounded");
  console.log("✓ Direct tool loop:", {
    tools: learnToolCalls.map((e) => e.name),
    officialTitle: parsed.officialTitle,
    learnUrl: parsed.learnUrl,
  });
}

async function testPlannerJourneyWithLlm(): Promise<void> {
  console.log("▶ Full planner journey with Foundry LLM + Learn MCP");

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

    logLines(
      "architect Learn activity",
      architectLearnLogs(state.logs),
    );

    assert(
      state.logs.some(
        (log) => log.actor === "architect" && /Connected to .*MCP/i.test(log.text),
      ),
      "Architect should log a Microsoft Learn MCP connection",
    );
    assert(
      usedArchitectTools(state.logs),
      "Architect must call tools while planning. LLM path used no tools.",
    );
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

    const learnCited =
      /learn\.microsoft\.com/i.test(graphBlob) ||
      state.logs.some((log) => /learn\.microsoft\.com/i.test(log.text));
    if (!learnCited) {
      console.log("  (plan did not embed a Learn URL; tool logs still prove MCP was used)");
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
      "I edited the auth epic to Easy Auth only, and added a NEW Feature for Direct Azure Blob Storage Chunked Upload with SAS tokens. Please break down tasks with Fibonacci functional/technical points, What/How in the description, and check Azure Learn guidance.";

    console.log("▶ Triggering Crew Revision Workflow with live LLM...");
    let revised = await startRevisionWorkflow(ws.id, planner(ws), reviewMessage);
    if (revised.status === "waiting_user_validation" && revised.activeAssumptionId) {
      revised = await resumePlannerWithValidation(ws.id, planner(ws), {
        assumptionId: revised.activeAssumptionId,
        approved: true,
        comment: "Approved Easy Auth and Blob Storage SAS upload revision",
      });
    }

    const revisionStart = revised.logs.findIndex(
      (log) => log.actor === "system" && /Revising .*dirty/i.test(log.text),
    );
    const revisionLogs = revisionStart >= 0 ? revised.logs.slice(revisionStart) : revised.logs;
    logLines("revision Learn activity", architectLearnLogs(revisionLogs));
    assert(
      usedArchitectTools(revisionLogs),
      "Architect must use tools while revising",
    );
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
  console.log("▶ Functional LLM test: Azure Foundry + Microsoft Learn MCP");
  console.log("  endpoint:", process.env.AZURE_OPENAI_ENDPOINT);
  console.log("  mcp:", process.env.MICROSOFT_LEARN_MCP_URL ?? "(default)");

  const model = await requireLiveLlm();
  const learn = await requireLearnMcp();
  try {
    await testPlannerJourneyWithLlm();
  } finally {
    await learn.close();
  }

  console.log("🎉 Functional LLM + Microsoft Learn MCP journey passed");
}

run().catch((err) => {
  console.error("Functional LLM test failed:", err);
  process.exit(1);
});

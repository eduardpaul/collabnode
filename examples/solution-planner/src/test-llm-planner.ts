import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { HumanMessage } from "@langchain/core/messages";
import { nodesOfType, type PlannerSession } from "./agent/session.ts";
import type { SolutionPlanner } from "./workspace.types.ts";
import type { CollabSession } from "@collabnode/runtime";
import { getChatModel } from "./agent/llm.ts";
import { runPlannerChat } from "./agent/crew.ts";
import { loadMicrosoftLearnTools } from "./agent/learn.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: join(root, ".env") });

const SOLUTION = [
  "Customer document portal on Azure.",
  "React SPA uploads files to an Azure Container Apps API.",
  "Authenticate users with Azure Container Apps Easy Auth (Microsoft Entra ID).",
  "Store metadata in Azure Cosmos DB and traces in Azure Application Insights.",
].join(" ");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function planner(ws: { session: CollabSession }): PlannerSession {
  return ws.session.as<SolutionPlanner>();
}

async function requireLiveLlm() {
  const model = getChatModel();
  assert(model, "LLM is required: set GEMINI_API_KEY, AZURE_OPENAI_API_KEY, or OPENAI_API_KEY in .env");
  const ping = await model.invoke([new HumanMessage("Reply with exactly: PONG")]);
  const text = typeof ping.content === "string" ? ping.content : JSON.stringify(ping.content);
  assert(/pong/i.test(text), `LLM ping failed, got: ${text.slice(0, 200)}`);
  console.log("✓ Live LLM connected");
  return model;
}

async function testPlannerChat(): Promise<void> {
  console.log("▶ Manager Deep Agent chat (architect as subagent)");

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
    await runPlannerChat({
      workspaceId: "test-llm-planner-1",
      session: planner(ws),
      workspaceType: type,
      message: SOLUTION,
      language: "en",
    });

    const snap = planner(ws).snapshot();
    const epics = nodesOfType(snap, "Epic");
    const features = nodesOfType(snap, "Feature");
    const tasks = nodesOfType(snap, "Task");
    const c4 = nodesOfType(snap, "C4DiagramElement");

    assert(epics.length >= 1, "Manager should create Epics");
    assert(features.length >= 1, "Manager should create Features");
    console.log("✓ LLM plan graph:", {
      epics: epics.length,
      features: features.length,
      c4: c4.length,
      tasks: tasks.length,
    });
  } finally {
    await hub.close();
    await close?.();
  }
}

async function run(): Promise<void> {
  console.log("▶ Functional LLM test: Deep Agents planner chat");
  await requireLiveLlm();
  const learn = await loadMicrosoftLearnTools();
  try {
    if (learn.tools.length > 0) {
      console.log(`✓ Microsoft Learn MCP: ${learn.serverName} (${learn.tools.map((t) => t.name).join(", ")})`);
    } else {
      console.log("  (Learn MCP unused this run)");
    }
    await testPlannerChat();
  } finally {
    await learn.close();
  }
  console.log("🎉 Functional LLM planner journey passed");
}

run().catch((err) => {
  console.error("Functional LLM test failed:", err);
  process.exit(1);
});

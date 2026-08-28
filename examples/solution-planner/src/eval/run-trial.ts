import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { nodesOfType, singletonOfType, type PlannerSession } from "../agent/session.ts";
import type { SolutionPlanner } from "../workspace.types.ts";
import type { CollabSession } from "@collabnode/runtime";
import { getChatModel } from "../agent/llm.ts";
import { crewLogs, dropCrew, runPlannerChat } from "../agent/crew.ts";
import { scorePlannerGraph } from "./rubric.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotEnv({ path: join(root, ".env") });

const DEFAULT_BRIEF = [
  "Customer document portal on Azure.",
  "React SPA uploads files to an Azure Container Apps API.",
  "Authenticate users with Azure Container Apps Easy Auth (Microsoft Entra ID).",
  "Store metadata in Azure Cosmos DB and traces in Azure Application Insights.",
].join(" ");

interface TrialInput {
  workspaceId?: string;
  brief?: string;
  managerPrompt?: string;
  architectPrompt?: string;
}

function planner(ws: { session: CollabSession }): PlannerSession {
  return ws.session.as<SolutionPlanner>();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  let input: TrialInput = {};
  const raw = await readStdin();
  if (raw.trim()) {
    input = JSON.parse(raw) as TrialInput;
  }

  const model = getChatModel();
  if (!model) {
    emit({
      score: 0,
      failures: ["no LLM configured"],
      counts: {},
      toolSequence: [],
      durationMs: 0,
      logsTail: [],
    });
    process.exitCode = 1;
    return;
  }

  const workspaceId = input.workspaceId?.trim() || `opt-${Date.now().toString(36)}`;
  const brief = input.brief?.trim() || DEFAULT_BRIEF;

  const { backend, close } = await openCollab({ kind: "memory" }, "server");
  const hub = await createHub({ collab: backend, sweepIntervalMs: 0 });
  const type = await loadWorkspaceTypeFile(join(root, "workspaces/solution-planner.yaml"));
  hub.define(type);
  const ws = await hub.open("solution-planner", {
    id: workspaceId,
    actorId: "server",
    params: { appName: "Azure Document Portal", language: "en" },
  });

  const started = Date.now();
  let error: string | undefined;
  try {
    await runPlannerChat({
      workspaceId,
      session: planner(ws),
      workspaceType: type,
      message: brief,
      language: "en",
      actor: "user",
      managerPrompt: input.managerPrompt,
      architectPrompt: input.architectPrompt,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("trial failed:", error);
  }

  const durationMs = Date.now() - started;
  const logs = crewLogs(workspaceId);
  const snap = planner(ws).snapshot();
  const rubric = scorePlannerGraph(snap, logs);
  const state = singletonOfType(snap, "SolutionState")?.properties;

  emit({
    score: error ? 0 : rubric.score,
    failures: error ? [`runtime: ${error}`, ...rubric.failures] : rubric.failures,
    passed: rubric.passed,
    checks: rubric.checks,
    counts: rubric.counts,
    titles: rubric.titles,
    toolSequence: rubric.toolSequence,
    durationMs,
    capped: rubric.capped,
    status: state?.status ?? null,
    managerAgrees: state?.managerAgrees === true,
    architectAgrees: state?.architectAgrees === true,
    logsTail: logs.slice(-40).map((l) => `[${l.actor}] ${l.text}`),
    nodeTitles: Object.fromEntries(
      (["Epic", "Feature", "Task", "C4DiagramElement", "Risk", "Assumption"] as const).map((t) => [
        t,
        nodesOfType(snap, t).map((n) => String(n.properties.title ?? n.id)),
      ]),
    ),
  });

  dropCrew(workspaceId);
  await hub.close();
  await close?.();
}

main().catch((err) => {
  emit({
    score: 0,
    failures: [err instanceof Error ? err.message : String(err)],
    counts: {},
    toolSequence: [],
    durationMs: 0,
    logsTail: [],
  });
  process.exit(1);
});

import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { nodesOfType, singletonOfType, type PlannerSession } from "./agent/session.ts";
import type { SolutionPlanner } from "./workspace.types.ts";
import type { CollabSession } from "@collabnode/runtime";
import { getChatModel } from "./agent/llm.ts";
import { crewLogs, runPlannerChat } from "./agent/crew.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: join(root, ".env") });
process.env.COLLAB_CREW_LOG = "1";

const SOLUTION = [
  "Customer document portal on Azure.",
  "React SPA uploads files to an Azure Container Apps API.",
  "Authenticate users with Azure Container Apps Easy Auth (Microsoft Entra ID).",
  "Store metadata in Azure Cosmos DB and traces in Azure Application Insights.",
].join(" ");

function planner(ws: { session: CollabSession }): PlannerSession {
  return ws.session.as<SolutionPlanner>();
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s - m * 60).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const model = getChatModel();
  if (!model) {
    throw new Error("No LLM configured");
  }
  console.log("model:", model.constructor.name);

  const { createSubAgentConfig, getDeepAgentConfig } = await import("@collabnode/deepagents");

  const { backend, close } = await openCollab({ kind: "memory" }, "server");
  const hub = await createHub({ collab: backend, sweepIntervalMs: 0 });
  const type = await loadWorkspaceTypeFile(join(root, "workspaces/solution-planner.yaml"));
  hub.define(type);
  const ws = await hub.open("solution-planner", {
    id: "validate-crew-1",
    actorId: "server",
    params: { appName: "Azure Document Portal", language: "en" },
  });

  const preview = getDeepAgentConfig({
    session: planner(ws).as(),
    workspaceType: type,
    role: "manager",
    language: "en",
    subagents: [
      createSubAgentConfig({
        session: planner(ws).as(),
        workspaceType: type,
        role: "architect",
        language: "en",
      }),
    ] as never,
  });
  console.log(
    "manager tools include task:",
    preview.tools.some((t) => t.name === "task"),
    "| subagents:",
    preview.subagents?.map((s) => ("name" in s ? s.name : "?")) ?? [],
  );

  const started = Date.now();
  const phaseMs: Record<string, number> = {};
  let failed = false;

  const dumpPhase = (label: string) => {
    const logs = crewLogs("validate-crew-1");
    const snap = planner(ws).snapshot();
    const state = singletonOfType(snap, "SolutionState")?.properties;
    console.log(`[${label}] logs=${logs.length} edges=${snap.edges.length} status=${state?.status}`);
    for (const log of logs.slice(-12)) {
      const line = log.text.length > 180 ? `${log.text.slice(0, 177)}...` : log.text;
      console.log(`  [${log.actor}] ${line}`);
    }
    console.log(
      `[${label}] nodes:`,
      Object.fromEntries(
        (["Epic", "Feature", "Task", "C4DiagramElement", "Risk", "Assumption"] as const).map(
          (t) => [t, nodesOfType(snap, t).length],
        ),
      ),
    );
  };

  const invoke = async (label: string, message: string, actor: "user" = "user") => {
    const t0 = Date.now();
    console.log(`\n--- ${label} ---`);
    const timeoutMs = 2 * 60 * 1000;
    try {
      await Promise.race([
        runPlannerChat({
          workspaceId: "validate-crew-1",
          session: planner(ws),
          workspaceType: type,
          message,
          language: "en",
          actor,
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`${label} timed out after ${fmtMs(timeoutMs)}`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      failed = true;
      console.error("invoke failed:", err instanceof Error ? err.message : err);
      const extra = err as { errors?: unknown[]; cause?: unknown };
      if (Array.isArray(extra.errors)) {
        for (const [i, inner] of extra.errors.entries()) {
          const msg = inner instanceof Error ? inner.message : String(inner);
          console.error(`  error[${i}]:`, msg.slice(0, 800));
        }
      }
    }
    phaseMs[label] = Date.now() - t0;
    console.log(`${label} duration:`, fmtMs(phaseMs[label]));
    dumpPhase(label);
  };

  await invoke("initial-plan", SOLUTION);

  const pendingId = singletonOfType(planner(ws).snapshot(), "SolutionState")?.properties
    .pendingAssumptionId;
  if (pendingId && !failed) {
    const assumption = planner(ws)
      .snapshot()
      .nodes.find((n) => n.id === pendingId);
    if (assumption && assumption.type === "Assumption") {
      await planner(ws).upsertNode(
        {
          id: pendingId,
          type: "Assumption",
          properties: {
            ...assumption.properties,
            status: "approved",
            userComment: "Approved for live validation",
          },
        },
        { actorId: "human-user" },
      );
      await invoke(
        "after-assumption-approved",
        `The human approved assumption "${String(assumption.properties.title)}". Continue the plan. Call view_solution_view and delegate C4, tasks, and technical risks to the architect.`,
      );
    }
  }

  const durationMs = Date.now() - started;

  const logs = crewLogs("validate-crew-1");
  const tools = logs.filter((l) => l.actor === "manager" || l.actor === "architect");
  const toolNames = tools
    .map((l) => l.text.split(":")[0]?.trim() ?? l.text)
    .filter(Boolean);

  const snap = planner(ws).snapshot();
  const state = singletonOfType(snap, "SolutionState")?.properties;
  const counts = {
    Epic: nodesOfType(snap, "Epic").length,
    Feature: nodesOfType(snap, "Feature").length,
    Task: nodesOfType(snap, "Task").length,
    C4DiagramElement: nodesOfType(snap, "C4DiagramElement").length,
    Risk: nodesOfType(snap, "Risk").length,
    Assumption: nodesOfType(snap, "Assumption").length,
  };

  console.log("\n=== duration ===");
  console.log(fmtMs(durationMs), `(${durationMs}ms)`);

  console.log("\n=== executed tasks / tool calls ===");
  if (tools.length === 0) {
    console.log("(none recorded)");
  } else {
    for (const log of tools) {
      const line = log.text.length > 220 ? `${log.text.slice(0, 217)}...` : log.text;
      console.log(`  [${log.actor}] ${line}`);
    }
  }
  const unique = [...new Set(toolNames)];
  console.log("unique tools:", unique.join(", ") || "(none)");
  console.log("tool-call count:", tools.length);

  console.log("\n=== final graph ===");
  console.log("status:", state?.status, "activeAgent:", state?.activeAgent);
  console.log("managerAgrees:", state?.managerAgrees, "architectAgrees:", state?.architectAgrees);
  console.log("pendingAssumptionId:", state?.pendingAssumptionId ?? "(none)");
  console.log("counts:", counts);
  for (const typeName of ["Epic", "Feature", "Task", "C4DiagramElement", "Risk", "Assumption"] as const) {
    for (const node of nodesOfType(snap, typeName)) {
      console.log(`  - ${typeName}: ${String(node.properties.title ?? node.id)}`);
    }
  }

  console.log("\n=== verdict ===");
  const ok =
    !failed &&
    counts.Epic >= 1 &&
    counts.Feature >= 1 &&
    tools.length >= 1;
  console.log(ok ? "PASS: manager wrote business scope via tools" : "FAIL: expected Epics/Features and tool calls");
  if (counts.Task === 0 && counts.C4DiagramElement === 0) {
    console.log("NOTE: architect did not write C4/Tasks this turn (delegation may not have run)");
  }

  await hub.close();
  await close?.();
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

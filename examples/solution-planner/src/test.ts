import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startPlannerWorkflow,
  resumePlannerWithValidation,
} from "./agent/graph.ts";

import { config as loadDotEnv } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: join(root, ".env") });

async function runTest() {
  console.log("▶ Testing Solution Planner End-to-End...");

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

  // 2. Trigger Manager agent turn
  console.log("▶ Triggering Manager agent...");
  const stateAfterManager = await startPlannerWorkflow(
    ws.id,
    ws.session,
    "Real-time collaborative document editor with AI",
    "en",
  );

  console.log("✓ State after first turn:", {
    status: stateAfterManager.status,
    activeAssumptionId: stateAfterManager.activeAssumptionId,
    managerAgrees: stateAfterManager.managerAgrees,
    iteration: stateAfterManager.iteration,
  });

  if (stateAfterManager.status !== "waiting_user_validation" || !stateAfterManager.activeAssumptionId) {
    throw new Error(`Expected waiting_user_validation with activeAssumptionId, got ${stateAfterManager.status}`);
  }

  // 3. Verify Assumption node was created in CollabSession
  const snap1 = ws.session.snapshot();
  const assumptionNode = snap1.nodes.find((n) => n.id === stateAfterManager.activeAssumptionId);
  if (!assumptionNode) {
    throw new Error("Assumption node not found in graph snapshot");
  }
  console.log("✓ Assumption created in graph:", assumptionNode.properties.title);

  // 4. Human-In-The-Loop Validation (Approve)
  console.log("▶ Human approving assumption...");
  const stateAfterValidation = await resumePlannerWithValidation(ws.id, ws.session, {
    assumptionId: stateAfterManager.activeAssumptionId,
    approved: true,
    comment: "Approved - Redis + Fluid backbone looks great",
  });

  console.log("✓ State after resume & architect turn:", {
    status: stateAfterValidation.status,
    managerAgrees: stateAfterValidation.managerAgrees,
    architectAgrees: stateAfterValidation.architectAgrees,
  });

  // 5. Verify final consensus and graph nodes
  const snap2 = ws.session.snapshot();
  const epics = snap2.nodes.filter((n) => n.type === "Epic");
  const features = snap2.nodes.filter((n) => n.type === "Feature");
  const tasks = snap2.nodes.filter((n) => n.type === "Task");
  const c4 = snap2.nodes.filter((n) => n.type === "C4Model");
  const risks = snap2.nodes.filter((n) => n.type === "Risk");

  // One SolutionState, however many turns the agents took. Without an id on the
  // write, an upsert of a type with no `identity:` mints a new node each time
  // and the UI reads whichever one the projection happens to return first.
  const states = snap2.nodes.filter((n) => n.type === "SolutionState");
  if (states.length !== 1) {
    throw new Error(`expected exactly one SolutionState node, found ${states.length}`);
  }

  console.log("✓ Final graph snapshot contents:");
  console.log(`  - Epics: ${epics.length}`);
  console.log(`  - Features: ${features.length}`);
  console.log(`  - C4 Models: ${c4.length}`);
  console.log(`  - Tasks: ${tasks.length}`);
  console.log(`  - Risks: ${risks.length}`);

  if (tasks.length === 0) {
    throw new Error("Expected tasks to be created by Architect");
  }

  // 6. Verify 6-axis task scoring structure
  const firstTask = tasks[0];
  console.log("✓ Sample 6-Axis Task Scoring:", {
    title: firstTask.properties.title,
    functionalPoints: firstTask.properties.functionalPoints,
    technicalPoints: firstTask.properties.technicalPoints,
    complexity: firstTask.properties.complexity,
    uncertainty: firstTask.properties.uncertainty,
    friction: firstTask.properties.friction,
    nfrScale: firstTask.properties.nfrScale,
  });

  if (
    firstTask.properties.complexity === undefined ||
    firstTask.properties.uncertainty === undefined ||
    firstTask.properties.friction === undefined ||
    firstTask.properties.nfrScale === undefined ||
    firstTask.properties.functionalPoints === undefined ||
    firstTask.properties.technicalPoints === undefined
  ) {
    throw new Error("Task missing required 6-axis estimation fields");
  }

  // 7. Verify Spanish Language Run
  console.log("▶ Testing Spanish language planner flow...");
  const wsEs = await hub.open("solution-planner", {
    id: "test-planner-es",
    actorId: "server",
    params: { appName: "Editor Colaborativo", language: "es" },
  });

  const stateEs1 = await startPlannerWorkflow(
    wsEs.id,
    wsEs.session,
    "Crear un editor colaborativo en tiempo real con IA",
    "es",
  );

  if (stateEs1.status !== "waiting_user_validation" || !stateEs1.activeAssumptionId) {
    throw new Error(`Expected waiting_user_validation for ES run`);
  }

  const stateEs2 = await resumePlannerWithValidation(wsEs.id, wsEs.session, {
    assumptionId: stateEs1.activeAssumptionId,
    approved: true,
    comment: "Aprobado por el usuario",
  });

  if (stateEs2.status !== "approved" || !stateEs2.managerAgrees || !stateEs2.architectAgrees) {
    throw new Error(`Expected approved consensus for ES run`);
  }

  const snapEs = wsEs.session.snapshot();
  const tasksEs = snapEs.nodes.filter((n) => n.type === "Task");
  console.log(`✓ Spanish flow passed with ${tasksEs.length} 6-axis tasks!`);

  await hub.close();
  await close?.();

  console.log("🎉 All Solution Planner tests passed successfully (EN & ES)!");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

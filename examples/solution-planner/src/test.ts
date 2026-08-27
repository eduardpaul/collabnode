import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startPlannerWorkflow,
  startRevisionWorkflow,
  resumePlannerWithValidation,
} from "./agent/graph.ts";
import {
  clearDirty,
  dirtyNodes,
  isDirty,
  markDirtyAndCascade,
  markParentDirtyOnDelete,
} from "./agent/dirty.ts";

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

  const dirtyAfterPlan = dirtyNodes(snap2);
  if (dirtyAfterPlan.length > 0) {
    throw new Error(`agent-created nodes should not be dirty, found ${dirtyAfterPlan.length}`);
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

  // 8. Task status toggle does not mark dirty
  console.log("▶ Testing dirty cascade and on-demand revision...");
  const snapBeforeDirty = ws.session.snapshot();
  const statusTask = snapBeforeDirty.nodes.find((n) => n.type === "Task");
  if (!statusTask) {
    throw new Error("Expected a Task for status-toggle dirty test");
  }
  await ws.session.upsertNode(
    {
      id: statusTask.id,
      type: "Task",
      properties: {
        ...statusTask.properties,
        status: "doing",
      },
    },
    { actorId: "human-user" },
  );
  const afterStatus = ws.session.snapshot().nodes.find((n) => n.id === statusTask.id);
  if (!afterStatus || isDirty(afterStatus)) {
    throw new Error("Task.status toggle must not mark the task dirty");
  }
  console.log("✓ Task status toggle did not mark dirty");

  // 9. Human edit on an Epic dirties the Epic, Features, and Tasks
  const epic = snapBeforeDirty.nodes.find((n) => n.type === "Epic");
  if (!epic) {
    throw new Error("Expected an Epic for cascade test");
  }
  await ws.session.upsertNode(
    {
      id: epic.id,
      type: "Epic",
      properties: {
        ...epic.properties,
        description: "Changed by human — needs crew revision",
      },
    },
    { actorId: "human-user" },
  );
  await markDirtyAndCascade(ws.session, epic.id);

  const snapCascaded = ws.session.snapshot();
  const dirtyEpic = snapCascaded.nodes.find((n) => n.id === epic.id);
  if (!dirtyEpic || !isDirty(dirtyEpic)) {
    throw new Error("Edited Epic should be dirty");
  }
  const featureIds = snapCascaded.edges
    .filter((e) => e.type === "HAS_FEATURE" && e.from === epic.id)
    .map((e) => e.to);
  if (featureIds.length === 0) {
    throw new Error("Expected HAS_FEATURE links from Epic for cascade test");
  }
  for (const id of featureIds) {
    const feat = snapCascaded.nodes.find((n) => n.id === id);
    if (!feat || !isDirty(feat)) {
      throw new Error(`Feature ${id} should be dirty because its Epic is dirty`);
    }
  }
  const taskIds = snapCascaded.edges
    .filter((e) => e.type === "HAS_TASK" && featureIds.includes(e.from))
    .map((e) => e.to);
  if (taskIds.length === 0) {
    throw new Error("Expected HAS_TASK links under dirty Epic features");
  }
  for (const id of taskIds) {
    const task = snapCascaded.nodes.find((n) => n.id === id);
    if (!task || !isDirty(task)) {
      throw new Error(`Task ${id} should be dirty because its Epic is dirty`);
    }
  }
  const solutionAfterDirty = snapCascaded.nodes.find((n) => n.type === "SolutionState");
  if (solutionAfterDirty?.properties.managerAgrees || solutionAfterDirty?.properties.architectAgrees) {
    throw new Error("Consensus should be broken after a human dirty edit");
  }
  console.log(
    `✓ Epic dirty cascaded to ${featureIds.length} feature(s) and ${taskIds.length} task(s)`,
  );

  // 10. Deleting a Feature dirties the parent Epic
  await clearDirty(ws.session, { actorId: "human-user" });
  const snapClean = ws.session.snapshot();
  const featureToDelete = snapClean.nodes.find(
    (n) => n.type === "Feature" && featureIds.includes(n.id),
  );
  if (!featureToDelete) {
    throw new Error("Expected a Feature to delete");
  }
  await markParentDirtyOnDelete(ws.session, featureToDelete.id);
  const connected = snapClean.edges.filter(
    (e) => e.from === featureToDelete.id || e.to === featureToDelete.id,
  );
  for (const edge of connected) {
    await ws.session.deleteEdge(edge.id, { actorId: "human-user" });
  }
  await ws.session.deleteNode(featureToDelete.id, { actorId: "human-user" });
  const epicAfterDelete = ws.session.snapshot().nodes.find((n) => n.id === epic.id);
  if (!epicAfterDelete || !isDirty(epicAfterDelete)) {
    throw new Error("Deleting a Feature should dirty the parent Epic");
  }
  console.log("✓ Deleting a Feature dirtied the parent Epic");

  // 11. On-demand Manager ↔ Architect revision clears dirty and reaches consensus
  let stateAfterRevise = await startRevisionWorkflow(ws.id, ws.session);
  if (stateAfterRevise.status === "waiting_user_validation" && stateAfterRevise.activeAssumptionId) {
    stateAfterRevise = await resumePlannerWithValidation(ws.id, ws.session, {
      assumptionId: stateAfterRevise.activeAssumptionId,
      approved: true,
      comment: "Approved during dirty revision test",
    });
  }
  if (stateAfterRevise.status !== "approved" || !stateAfterRevise.managerAgrees || !stateAfterRevise.architectAgrees) {
    throw new Error(
      `Expected approved consensus after revision, got status=${stateAfterRevise.status}`,
    );
  }
  const snapRevised = ws.session.snapshot();
  const leftoverDirty = dirtyNodes(snapRevised);
  if (leftoverDirty.length > 0) {
    throw new Error(`expected dirty flags cleared after revision, found ${leftoverDirty.length}`);
  }
  const epicsAfter = snapRevised.nodes.filter((n) => n.type === "Epic");
  const tasksAfter = snapRevised.nodes.filter((n) => n.type === "Task");
  const risksAfter = snapRevised.nodes.filter((n) => n.type === "Risk");
  if (epicsAfter.length === 0 || tasksAfter.length === 0) {
    throw new Error("Revision must not wipe Epics/Tasks");
  }
  if (risksAfter.length <= risks.length) {
    throw new Error("Expected revision to add at least one risk while adapting the plan");
  }
  console.log(
    `✓ Revision loop approved with dirty cleared (${epicsAfter.length} epics, ${tasksAfter.length} tasks, ${risksAfter.length} risks)`,
  );

  await hub.close();
  await close?.();

  console.log("🎉 All Solution Planner tests passed successfully (EN & ES)!");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

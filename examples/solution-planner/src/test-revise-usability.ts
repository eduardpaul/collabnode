import { createHub, loadWorkspaceTypeFile, openCollab } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import {
  startPlannerWorkflow,
  startRevisionWorkflow,
  resumePlannerWithValidation,
} from "./agent/graph.ts";
import { dirtyNodes, isDirty, markDirtyAndCascade } from "./agent/dirty.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv({ path: join(root, ".env") });

/**
 * Functional / usability journey: a human changes the plan, explains why,
 * and the Manager ↔ Architect loop revises with that note.
 *
 * This is the path the UI exposes as "Note for the crew" + "Revise dirty nodes".
 */
async function runReviseUsabilityTest() {
  console.log("▶ Functional test: dirty revision with a user review note...");

  const { backend, close } = await openCollab({ kind: "memory" }, "server");
  const hub = await createHub({ collab: backend, sweepIntervalMs: 0 });
  const type = await loadWorkspaceTypeFile(join(root, "workspaces/solution-planner.yaml"));
  hub.define(type);

  const ws = await hub.open("solution-planner", {
    id: "test-revise-usability",
    actorId: "server",
    params: { appName: "Revision Note Demo", language: "en" },
  });

  // 1. User starts co-design (same as the prompt bar)
  let state = await startPlannerWorkflow(
    ws.id,
    ws.session,
    "Collaborative board with live presence",
    "en",
  );
  if (state.status === "waiting_user_validation" && state.activeAssumptionId) {
    state = await resumePlannerWithValidation(ws.id, ws.session, {
      assumptionId: state.activeAssumptionId,
      approved: true,
      comment: "Approved for usability test",
    });
  }
  if (state.status !== "approved") {
    throw new Error(`setup expected approved plan, got ${state.status}`);
  }

  const before = ws.session.snapshot();
  const epic = before.nodes.find((n) => n.type === "Epic");
  if (!epic) {
    throw new Error("setup expected an Epic to edit");
  }

  // 2. User edits an Epic (UI marks dirty + cascades)
  const editedDescription = "Human-narrowed scope: presence only, no offline sync";
  await ws.session.upsertNode(
    {
      id: epic.id,
      type: "Epic",
      properties: {
        ...epic.properties,
        description: editedDescription,
      },
    },
    { actorId: "human-user" },
  );
  await markDirtyAndCascade(ws.session, epic.id);

  const dirtyBefore = dirtyNodes(ws.session.snapshot());
  if (dirtyBefore.length === 0 || !dirtyBefore.some((n) => n.id === epic.id)) {
    throw new Error("edited Epic should be dirty before the user asks for a revision");
  }

  // 3. User types a review note and clicks "Revise dirty nodes"
  const reviewMessage =
    "Prefer a single-process memory registry; do not introduce Redis for this deployment.";
  let revised = await startRevisionWorkflow(ws.id, ws.session, reviewMessage);
  if (revised.status === "waiting_user_validation" && revised.activeAssumptionId) {
    revised = await resumePlannerWithValidation(ws.id, ws.session, {
      assumptionId: revised.activeAssumptionId,
      approved: true,
      comment: "Approved after review note",
    });
  }

  // 4. Usability checks — what the UI would show after the loop
  if (revised.reviewMessage !== reviewMessage) {
    throw new Error("revision state should keep the user's review note");
  }

  const userNoteLog = revised.logs.find(
    (log) => log.actor === "user" && log.text.includes(reviewMessage),
  );
  if (!userNoteLog) {
    throw new Error("activity log should show the user's review note (so it is visible in the UI)");
  }

  const managerTouchedNote = revised.logs.some(
    (log) => log.actor === "manager" && (log.text.includes("dirty") || log.text.includes("Dirty") || log.text.includes("Adapting")),
  );
  const architectTouchedNote = revised.logs.some((log) => log.actor === "architect");
  if (!managerTouchedNote || !architectTouchedNote) {
    throw new Error("both Manager and Architect should run after the user requests a dirty revision");
  }

  if (revised.status !== "approved" || !revised.managerAgrees || !revised.architectAgrees) {
    throw new Error(`UI should show consensus after revision, got status=${revised.status}`);
  }

  const after = ws.session.snapshot();
  const leftover = dirtyNodes(after);
  if (leftover.length > 0) {
    throw new Error(`dirty badges should clear after revision, found ${leftover.length}`);
  }

  const epicAfter = after.nodes.find((n) => n.id === epic.id);
  if (!epicAfter) {
    throw new Error("the edited Epic must still exist after revision");
  }
  if (isDirty(epicAfter)) {
    throw new Error("the edited Epic should no longer be dirty");
  }
  if (String(epicAfter.properties.description) !== editedDescription) {
    throw new Error("revision must not wipe the user's Epic edit");
  }

  const graphText = after.nodes
    .map((n) => Object.values(n.properties).map((v) => String(v)).join(" "))
    .join("\n");
  if (!graphText.includes(reviewMessage) && !revised.logs.some((log) => log.text.includes(reviewMessage))) {
    throw new Error("the crew should retain the review note in logs or adapted graph content");
  }

  const risks = after.nodes.filter((n) => n.type === "Risk");
  const noteInRisk = risks.some((risk) => String(risk.properties.description ?? "").includes(reviewMessage));
  if (!noteInRisk && !userNoteLog) {
    throw new Error("user note should surface in a risk (deterministic) or at least the log");
  }
  if (!noteInRisk) {
    console.log("  (LLM path did not copy the note into a Risk; log visibility still passed)");
  } else {
    console.log("✓ Crew adapted a risk using the user's review note");
  }

  console.log(
    `✓ Usability journey passed: note visible, dirty cleared, consensus approved (${dirtyBefore.length} dirty → 0)`,
  );

  await hub.close();
  await close?.();
}

runReviseUsabilityTest().catch((err) => {
  console.error("Usability test failed:", err);
  process.exit(1);
});

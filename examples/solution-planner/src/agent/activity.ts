import type { PlannerSession } from "./session.ts";

export type ActiveAgent = "none" | "manager" | "architect";

/**
 * The board reads SolutionState to tell the user what is going on, but an agent
 * only writes SolutionState once its whole step is finished. Marking the run on
 * the shared graph is what makes "the Architect is working right now" visible
 * while it is still working, instead of a minute later.
 */
export async function setActiveAgent(session: PlannerSession, actor: ActiveAgent): Promise<void> {
  await session.upsertNode(
    { type: "SolutionState", properties: { activeAgent: actor } },
    { actorId: actor === "none" ? "system" : `ai-${actor}` },
  );
}

/**
 * Runs `step` with the agent flagged as active, and clears the flag even when
 * the step throws — a crashed agent that leaves the board saying "working"
 * looks identical to one that is still thinking.
 */
export async function withActiveAgent<T>(
  session: PlannerSession,
  actor: Exclude<ActiveAgent, "none">,
  step: () => Promise<T>,
): Promise<T> {
  await setActiveAgent(session, actor);
  try {
    return await step();
  } finally {
    await setActiveAgent(session, "none");
  }
}

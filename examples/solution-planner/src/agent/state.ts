import type { CollabSession } from "@collabnode/runtime";

/**
 * The one SolutionState node, updated in place.
 *
 * `SolutionState` has no `identity:` in the workspace YAML — there is nothing
 * about it worth keying on, since a solution can be renamed — so an upsert
 * without an id would mint a *new* node on every agent step. The graph would
 * then hold one SolutionState per step, and the UI, which reads the first one
 * it finds, would show whichever the projection happened to return.
 *
 * So the id of the node already there is what makes this an update.
 */
export async function writeSolutionState(
  session: CollabSession,
  actorId: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const existing = session.snapshot().nodes.find((node) => node.type === "SolutionState");
  return session.upsertNode(
    {
      ...(existing ? { id: existing.id } : {}),
      type: "SolutionState",
      properties,
    },
    { actorId },
  );
}

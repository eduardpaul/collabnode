import type { CollabSession } from "@collabnode/runtime";
import {
  edgesOfType,
  findOfType,
  nodeOfType,
  ofType,
  nodesOfType,
  singletonOfType,
} from "@collabnode/runtime";
import type { SolutionPlanner } from "../workspace.types.ts";

/** This app's session, typed against `solution-planner.yaml`. */
export type PlannerSession = CollabSession<SolutionPlanner>;

export type PlannerSnapshot = ReturnType<PlannerSession["snapshot"]>;
export type PlannerNode = PlannerSnapshot["nodes"][number];
export type PlannedNode = Exclude<PlannerNode, { type: "SolutionState" }>;

export { edgesOfType, findOfType, nodeOfType, nodesOfType, ofType, singletonOfType };

import type { CollabSession } from "@collabnode/runtime";
import {
  edgesOfType,
  findOfType,
  nodeOfType,
  ofType,
  nodesOfType,
  nodesOfTypes,
  singletonOfType,
  type EdgeOf as LibEdgeOf,
  type NodeOf as LibNodeOf,
} from "@collabnode/runtime";
import type { EdgeTypeName, NodeTypeName, SolutionPlanner } from "../workspace.types.ts";

/**
 * This app's session, typed against its own workspace.
 *
 * `CollabSession` on its own is schema-agnostic — `type` is a string and
 * `properties` a bag — because the runtime serves any YAML. Naming the schema
 * once here is what turns every read and write in the planner into something
 * the compiler checks against `solution-planner.yaml`.
 */
export type PlannerSession = CollabSession<SolutionPlanner>;

/** What a snapshot of this workspace looks like. */
export type PlannerSnapshot = ReturnType<PlannerSession["snapshot"]>;

/** One node of this workspace, as a union discriminated on `type`. */
export type PlannerNode = PlannerSnapshot["nodes"][number];
export type PlannerEdge = PlannerSnapshot["edges"][number];

/**
 * One node type's record, with that type's own properties.
 *
 * `nodesOfType`, `nodeOfType`, `singletonOfType` and `edgesOfType` come from the
 * library — they are useful to anything holding a typed snapshot, not just this
 * app — and are re-exported here bound to this workspace so call sites do not
 * repeat the schema.
 */
export type NodeOf<T extends NodeTypeName> = LibNodeOf<SolutionPlanner, T>;
export type EdgeOf<T extends EdgeTypeName> = LibEdgeOf<SolutionPlanner, T>;

export { edgesOfType, findOfType, nodeOfType, nodesOfType, nodesOfTypes, ofType, singletonOfType };

/**
 * Every node that carries the `dirty` flag — which is all of them except the
 * singleton `SolutionState`, whose job is to hold the run's status rather than
 * to be planned.
 */
export type PlannedNode = Exclude<PlannerNode, { type: "SolutionState" }>;

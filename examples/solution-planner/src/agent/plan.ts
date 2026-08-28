import { planEnvelope, planZod, type GraphPlan, type InputOf, type PlanEdge, type PlanNode } from "collabnode";
import { applyPlan as applyGraphPlan, type ApplyPlanResult } from "@collabnode/deepagents";
import { z } from "zod";
import { getPlannerWorkspaceType } from "./workspace-def.ts";
import { normalizeTaskProperties } from "./schemas.ts";
import type { EdgeTypeName, NodeTypeName, SolutionPlanner } from "../workspace.types.ts";
import type { PlannerSession } from "./session.ts";

/**
 * The plan an agent hands back, and how it lands in the graph.
 *
 * The shape is not written here: `planZod` derives it from the workspace YAML,
 * so a property that gains an enum value or a node type that gains a guideline
 * reaches the model without a second copy of the schema being edited to match.
 * The *types* come from the same YAML by the other route — the generated
 * `workspace.types.ts` — so a node type or property this file names wrongly is
 * a compile error rather than a runtime `unknown node type`.
 *
 * Everything is a handle, never a title. A node the plan creates carries a
 * `ref` it chose; a node already in the graph is named by its `id`, which the
 * context markdown prints next to every node. Titles change when a human
 * renames something, and two nodes are allowed to share one — matching on a
 * title silently links the wrong node, which is exactly what edges exist to
 * prevent.
 *
 * Writing the plan is `applyPlan` from `@collabnode/deepagents`; what stays
 * here is the part that is this planner's — which roles may write what, which
 * properties the runtime owns, and how a Task's points are normalised.
 */

/** Node types each role may write, and the edges it may draw between them. */
const SCOPE = {
  manager: {
    nodes: ["Epic", "Feature", "Risk", "Assumption"],
    edges: ["HAS_FEATURE", "HAS_RISK", "HAS_ASSUMPTION"],
  },
  architect: {
    nodes: ["C4DiagramElement", "Task", "Risk"],
    edges: ["CONTAINS", "USES", "HAS_TASK", "TARGETS_C4", "HAS_RISK"],
  },
} as const satisfies Record<string, { nodes: readonly NodeTypeName[]; edges: readonly EdgeTypeName[] }>;

/**
 * Properties the runtime owns, per type. `dirty` marks unrevised *human* edits,
 * `status` is the human's to move, and `category` follows from which agent
 * wrote the risk — none of them are the model's to set, so they are not in the
 * schema it answers against.
 *
 * Keyed to the real property names: a name that no longer exists used to omit
 * nothing, silently, and leave the model free to write a field we meant to
 * reserve.
 */
const RUNTIME_OWNED = {
  Epic: ["dirty"],
  Feature: ["dirty"],
  Risk: ["dirty", "category"],
  Assumption: ["dirty", "status", "raisedBy", "userComment"],
  C4DiagramElement: ["dirty"],
  Task: ["dirty"],
} as const satisfies {
  [T in NodeTypeName]?: readonly (keyof InputOf<SolutionPlanner, T> & string)[];
};

export type PlannerRole = keyof typeof SCOPE;

/**
 * One plan entry, in the write shape rather than the strict one.
 *
 * What the model returns under strict mode — every key present, `null` for "no
 * value" — is assignable to this, and so is a hand-built fallback that names
 * only the properties it cares about. `applyPlan` drops the nulls on the way in.
 */
export type PlannerPlanNode = PlanNode<SolutionPlanner, NodeTypeName>;
export type PlannerPlanEdge = PlanEdge<SolutionPlanner, EdgeTypeName>;

/** The plan, plus what this planner asks for around it. */
export type PlannerPlan = GraphPlan<SolutionPlanner> & {
  review: string;
  removeEdges: string[];
  agrees: boolean;
};

/** The structured-output schema for one role, derived from the workspace YAML. */
export async function plannerPlanSchema(role: PlannerRole, language: "en" | "es") {
  const workspaceType = await getPlannerWorkspaceType();
  const scope = SCOPE[role];
  const isEs = language === "es";
  const plan = planZod<SolutionPlanner>(workspaceType.schema, {
    language,
    // Azure/OpenAI strict json_schema wants every key in `required`, so "no
    // value" travels as null rather than as an absent key.
    mode: "strict",
    nodeTypes: scope.nodes,
    edgeTypes: scope.edges,
    omit: RUNTIME_OWNED,
  });

  // `review` is asked before the plan and `agrees` after it, because a model
  // fills a structured answer in schema order: think first, judge last.
  return planEnvelope(plan, {
    before: {
      review: z
        .string()
        .describe(
          isEs
            ? "Una frase sobre lo que cambiaste y por qué."
            : "One sentence on what you changed and why.",
        ),
    },
    after: {
      removeEdges: z
        .array(z.string())
        .describe(
          isEs
            ? "Ids de aristas a eliminar — la única forma de re-enlazar algo que ya existe."
            : "Ids of edges to remove — the only way to re-parent something that already exists.",
        ),
      agrees: z
        .boolean()
        .describe(
          isEs
            ? "true si el plan resultante te parece completo, false si aún falta trabajo."
            : "true if the resulting plan looks complete to you, false if work remains.",
        ),
    },
  });
}

/** An empty plan, for the offline paths to fill in. */
export function emptyPlan(): PlannerPlan {
  return { review: "", nodes: [], edges: [], removeEdges: [], agrees: true };
}

export interface ApplyPlanOptions {
  actorId: string;
  language: "en" | "es";
  /** Properties stamped onto every node of a type, over what the model wrote. */
  stamp?: { [T in NodeTypeName]?: Partial<InputOf<SolutionPlanner, T>> };
}

export type { ApplyPlanResult };

/**
 * Writes a plan as one atomic batch, with this planner's own house rules.
 *
 * The resolution and dropping is `applyPlan`'s; what is passed in here is what
 * only this app knows — that an untitled node is not a plan entry, that a Task's
 * points arrive as prose often enough to be worth normalising, and that
 * anything an agent writes is by definition not a pending human edit.
 */
export async function applyPlan(
  session: PlannerSession,
  plan: PlannerPlan,
  options: ApplyPlanOptions,
): Promise<ApplyPlanResult> {
  return applyGraphPlan(session, plan, {
    actorId: options.actorId,
    removeEdges: plan.removeEdges,
    stamp: options.stamp,
    transform: (node, properties) => {
      // A node type keyed on title has nothing to be found by without one, and
      // an untitled Feature is not in the plan whatever else it carries.
      if (properties.title !== undefined && !String(properties.title).trim()) {
        return undefined;
      }
      return {
        ...(node.type === "Task"
          ? normalizeTaskProperties(properties, { language: options.language })
          : properties),
        dirty: false,
      };
    },
  });
}

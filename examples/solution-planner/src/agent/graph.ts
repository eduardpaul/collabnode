import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import type { CollabSession } from "@collabnode/runtime";
import type { PlannerState, UserValidationPayload, AgentLog } from "./types.ts";
import { runManagerStep } from "./manager.ts";
import { runArchitectStep } from "./architect.ts";

// Session lookup registry by workspaceId
const sessionRegistry = new Map<string, CollabSession>();
const stateRegistry = new Map<string, PlannerState>();

export function registerPlannerSession(workspaceId: string, session: CollabSession): void {
  sessionRegistry.set(workspaceId, session);
}

export function getPlannerState(workspaceId: string): PlannerState | undefined {
  return stateRegistry.get(workspaceId);
}

// LangGraph State Annotation
const PlannerAnnotation = Annotation.Root({
  workspaceId: Annotation<string>,
  description: Annotation<string>,
  language: Annotation<"en" | "es">,
  iteration: Annotation<number>,
  managerAgrees: Annotation<boolean>,
  architectAgrees: Annotation<boolean>,
  status: Annotation<"idle" | "planning" | "waiting_user_validation" | "approved">,
  activeAssumptionId: Annotation<string | undefined>,
  userValidation: Annotation<UserValidationPayload | undefined>,
  logs: Annotation<AgentLog[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
});

export function createPlannerGraph() {
  const workflow = new StateGraph(PlannerAnnotation)
    .addNode("manager", async (state) => {
      const session = sessionRegistry.get(state.workspaceId);
      if (!session) throw new Error(`CollabSession not found for workspace ${state.workspaceId}`);
      const next = await runManagerStep(session, state as PlannerState);
      const merged = { ...state, ...next };
      stateRegistry.set(state.workspaceId, merged as PlannerState);
      return next;
    })
    .addNode("architect", async (state) => {
      const session = sessionRegistry.get(state.workspaceId);
      if (!session) throw new Error(`CollabSession not found for workspace ${state.workspaceId}`);
      const next = await runArchitectStep(session, state as PlannerState);
      const merged = { ...state, ...next };
      stateRegistry.set(state.workspaceId, merged as PlannerState);
      return next;
    })
    .addEdge(START, "manager")
    .addConditionalEdges("manager", (state) => {
      if (state.status === "waiting_user_validation") {
        return END; // Pauses graph for human-in-the-loop validation
      }
      if (state.managerAgrees && state.architectAgrees) {
        return END;
      }
      return "architect";
    })
    .addConditionalEdges("architect", (state) => {
      if (state.status === "waiting_user_validation") {
        return END;
      }
      if (state.managerAgrees && state.architectAgrees) {
        return END;
      }
      if (state.iteration >= 3) {
        return END; // Safety limit
      }
      return "manager"; // Cyclic loop back to Manager!
    });

  return workflow.compile();
}

const compiledGraph = createPlannerGraph();

/**
 * Start the LangGraph multi-agent planning process.
 */
export async function startPlannerWorkflow(
  workspaceId: string,
  session: CollabSession,
  description: string,
  language: "en" | "es",
): Promise<PlannerState> {
  registerPlannerSession(workspaceId, session);

  const initialState: PlannerState = {
    workspaceId,
    description,
    language,
    iteration: 0,
    managerAgrees: false,
    architectAgrees: false,
    status: "planning",
    logs: [
      {
        actor: "system",
        text: language === "es"
          ? `🚀 Iniciando planificación de solución para: "${description}"`
          : `🚀 Starting solution planning for: "${description}"`,
        at: new Date().toISOString(),
      },
    ],
  };

  stateRegistry.set(workspaceId, initialState);

  const result = await compiledGraph.invoke(initialState);
  const finalState = { ...initialState, ...result } as PlannerState;
  stateRegistry.set(workspaceId, finalState);
  return finalState;
}

/**
 * Resume the LangGraph workflow after human approval or rejection of an assumption.
 */
export async function resumePlannerWithValidation(
  workspaceId: string,
  session: CollabSession,
  validation: UserValidationPayload,
): Promise<PlannerState> {
  registerPlannerSession(workspaceId, session);
  const currentState = stateRegistry.get(workspaceId);

  if (!currentState) {
    throw new Error(`No planning state found for workspace ${workspaceId}`);
  }

  const isEs = currentState.language === "es";

  // Update Assumption node in CollabSession
  const snapshot = session.snapshot();
  const assumptionNode = snapshot.nodes.find((n) => n.id === validation.assumptionId);

  if (assumptionNode) {
    await session.upsertNode(
      {
        id: validation.assumptionId,
        type: "Assumption",
        properties: {
          ...assumptionNode.properties,
          status: validation.approved ? "approved" : "rejected",
          userComment: validation.comment || (validation.approved ? (isEs ? "Aprobado por el usuario" : "Approved by user") : (isEs ? "Rechazado por el usuario" : "Rejected by user")),
        },
      },
      { actorId: "human-user" },
    );
  }

  const updatedLogs: AgentLog[] = [
    ...currentState.logs,
    {
      actor: "user",
      text: validation.approved
        ? (isEs ? `👤 Usuario APROBÓ la suposición "${assumptionNode?.properties.title ?? ""}"` : `👤 User APPROVED assumption "${assumptionNode?.properties.title ?? ""}"`)
        : (isEs ? `👤 Usuario RECHAZÓ la suposición "${assumptionNode?.properties.title ?? ""}"` : `👤 User REJECTED assumption "${assumptionNode?.properties.title ?? ""}"`),
      at: new Date().toISOString(),
    },
  ];

  const resumedState: PlannerState = {
    ...currentState,
    status: "planning",
    managerAgrees: true,
    activeAssumptionId: undefined,
    userValidation: validation,
    logs: updatedLogs,
  };

  stateRegistry.set(workspaceId, resumedState);

  // Directly execute Architect step to reflect user's validation immediately
  const architectNext = await runArchitectStep(session, resumedState);
  const finalState = { ...resumedState, ...architectNext } as PlannerState;
  stateRegistry.set(workspaceId, finalState);
  return finalState;
}

/**
 * Execute a single turn of the specified agent on demand.
 */
export async function runSingleAgentStep(
  workspaceId: string,
  session: CollabSession,
  actor: "manager" | "architect",
): Promise<PlannerState> {
  registerPlannerSession(workspaceId, session);
  let currentState = stateRegistry.get(workspaceId);

  if (!currentState) {
    const snap = session.snapshot();
    const solution = snap.nodes.find((n) => n.type === "SolutionState");
    currentState = {
      workspaceId,
      description: String(solution?.properties.description || "Solution Planning"),
      language: (solution?.properties.language as "en" | "es") || "en",
      iteration: Number(solution?.properties.iteration || 0),
      managerAgrees: Boolean(solution?.properties.managerAgrees),
      architectAgrees: Boolean(solution?.properties.architectAgrees),
      status: "planning",
      logs: [],
    };
  }

  if (actor === "manager") {
    const next = await runManagerStep(session, currentState);
    const updated = { ...currentState, ...next } as PlannerState;
    stateRegistry.set(workspaceId, updated);
    return updated;
  } else {
    const next = await runArchitectStep(session, currentState);
    const updated = { ...currentState, ...next } as PlannerState;
    stateRegistry.set(workspaceId, updated);
    return updated;
  }
}

import { edgesOfType, nodesOfType, ofType, type PlannerSession } from "./session.ts";
import { snapshotToMarkdown } from "collabnode";
import type { PlannerState, AgentLog } from "./types.ts";
import { getChatModel } from "./llm.ts";
import { invokeStructured } from "@collabnode/deepagents";
import { dirtyNodes, formatRevisionContext, formatUserReviewGuidance } from "./dirty.ts";
import {
  applyPlan,
  emptyPlan,
  plannerPlanSchema,
  type ApplyPlanOptions,
  type PlannerPlan,
} from "./plan.ts";
import type { z } from "zod";

import { getDeepAgentConfig } from "@collabnode/deepagents";
import { getPlannerWorkspaceType } from "./workspace-def.ts";
import { missingC4Levels, splitCombinedC4PlanNodes } from "./c4.ts";
import { withActiveAgent } from "./activity.ts";

/** A technical risk is what the Architect raises; the category is not the model's call. */
/** Written over whatever the model said. `satisfies` pins `category` to the schema's enum. */
const ARCHITECT_STAMP = {
  Risk: { category: "technical" },
} satisfies ApplyPlanOptions["stamp"];

/**
 * One structured call for this role's nodes. Graph context is in the prompt;
 * tools belong on a Deep Agent, not on this helper.
 */
async function invokeArchitectStructured<T extends z.ZodTypeAny>(
  session: PlannerSession,
  model: NonNullable<ReturnType<typeof getChatModel>>,
  schema: T,
  prompt: string,
  name: string,
  isEs: boolean,
): Promise<z.infer<T>> {
  const workspaceType = await getPlannerWorkspaceType();
  const agentConfig = getDeepAgentConfig({
    session: session.as(),
    workspaceType,
    role: "architect",
    language: isEs ? "es" : "en",
    model,
  });

  return invokeStructured(model, schema, prompt, name, {
    system: agentConfig.systemPrompt,
  });
}

export async function runArchitectStep(
  session: PlannerSession,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
  return withActiveAgent(session, "architect", () => runArchitectTurn(session, state));
}

async function runArchitectTurn(
  session: PlannerSession,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
  if (state.mode === "revise") {
    return runArchitectRevise(session, state);
  }

  const isEs = state.language === "es";
  const iteration = state.iteration;
  const logs: AgentLog[] = [...state.logs];
  const model = getChatModel();

  const logMessage = (text: string) => {
    logs.push({
      actor: "architect",
      text,
      at: new Date().toISOString(),
    });
  };

  logMessage(
    isEs
      ? `[Iteración ${iteration}] Arquitecto diseñando modelo C4 y descomposición de tareas (puntos + ejes).`
      : `[Iteration ${iteration}] Architect designing C4 model and scored task breakdown.`,
  );

  // Read current snapshot from shared collab session
  const snapshot = session.snapshot();
  const features = nodesOfType(snapshot, "Feature");

  // Ids, not titles: the markdown prints `id:` next to every node, and that id
  // is what a task's HAS_TASK edge points at.
  const contextMarkdown = snapshotToMarkdown(snapshot, {
    types: ["Epic", "Feature", "Assumption", "Risk"],
  });

  let plan: PlannerPlan = emptyPlan();

  if (model) {
    try {
      const schema = await plannerPlanSchema("architect", isEs ? "es" : "en");
      const prompt = isEs
        ? `Eres un Arquitecto de Software (AI Architect). Analiza el alcance de la solución definido por el Gestor:

${contextMarkdown}

Devuelve un plan de nodos y aristas:
1. Modelo C4 completo, un nodo C4DiagramElement por elemento. Un diagrama de contenedores por sí solo NO es un modelo C4: incluye al menos un Person, un Boundary para el sistema que se diseña, un System (external:true) por cada sistema de terceros, y Components dentro del Container con más lógica.
   El anidamiento es la arista CONTAINS (del contenedor al contenido) y las llamadas son la arista USES.
2. Tareas técnicas accionables para las features de arriba. Cada Task necesita:
   - description con "Qué:" y "Cómo:" en líneas separadas;
   - functionalPoints y technicalPoints entre 1 y 21 (escala Fibonacci por convención), más complexity, uncertainty, friction y nfrScale;
   - una arista HAS_TASK desde el id del Feature que implementa — una tarea sin ese enlace no está en el plan;
   - una arista TARGETS_C4 hacia el elemento C4 que modifica, si aplica.
3. 1-2 Riesgos técnicos, cada uno con una arista HAS_RISK desde la tarea, feature o elemento C4 que amenaza.

Los extremos de las aristas son ids del grafo de arriba o refs de este mismo plan. Nunca títulos.`
        : `You are an AI Software Architect. Review the business scope and features defined for this solution:

${contextMarkdown}

Return a plan of nodes and edges:
1. A complete C4 model, one C4DiagramElement node per element. A container diagram alone is NOT a C4 model: include at least one Person, one Boundary for the system being designed, a System (external:true) per third-party system, and Components inside the Container carrying the most logic.
   Nesting is the CONTAINS edge (container → contained); calls are the USES edge.
2. Actionable technical tasks for the features above. Every Task needs:
   - a description with "What:" and "How:" on separate lines;
   - functionalPoints and technicalPoints from 1 to 21 (Fibonacci ladder by convention), plus complexity, uncertainty, friction, and nfrScale;
   - a HAS_TASK edge from the id of the Feature it implements — a task without that edge is not in the plan;
   - a TARGETS_C4 edge to the C4 element it changes, where one applies.
3. 1-2 technical risks, each with a HAS_RISK edge from the task, feature, or C4 element it threatens.

Edge endpoints are ids from the graph above or refs from this same plan. Never titles.`;

      plan = await invokeArchitectStructured(
        session,
        model,
        schema,
        prompt,
        "architect_plan",
        isEs,
      );
      if (plan.review?.trim()) {
        logMessage(plan.review.trim());
      }
    } catch (err) {
      console.warn("LLM architect structured output error, writing nothing:", err);
      logMessage(
        isEs
          ? "⚠️ El arquitecto no pudo generar un plan; no se escribió nada en el grafo."
          : "⚠️ Architect could not produce a plan; nothing was written to the graph.",
      );
      plan = emptyPlan();
    }
  }

  plan = { ...plan, nodes: splitCombinedC4PlanNodes(plan.nodes) };

  const missingLevels = missingC4Levels(
    // Narrowed, so `properties.type` is the C4 kind union rather than unknown.
    ofType(plan.nodes, "C4DiagramElement").map((node) => ({
      type: node.properties.type ?? "",
    })),
  );
  if (missingLevels.length > 0) {
    logMessage(
      isEs
        ? `⚠️ El modelo C4 no tiene ningún elemento de tipo: ${missingLevels.join(", ")}.`
        : `⚠️ C4 model has no element of type: ${missingLevels.join(", ")}.`,
    );
  }

  const written = await applyPlan(session, plan, {
    actorId: "ai-architect",
    language: isEs ? "es" : "en",
    stamp: ARCHITECT_STAMP,
  });
  for (const dropped of written.droppedEdges) {
    logMessage(
      isEs
        ? `⚠️ Relación descartada (extremo desconocido): ${dropped}`
        : `⚠️ Dropped relationship (unknown endpoint): ${dropped}`,
    );
  }
  reportUnlinkedTasks(session, plan, written.idsByRef, isEs, logMessage);

  const architectAgrees = true;

  logMessage(
    isEs
      ? `✅ Arquitecto aprueba la arquitectura técnica y el desglose de tareas.`
      : `✅ Architect approves technical architecture and task estimation.`,
  );

  const consensusReached = state.managerAgrees && architectAgrees;

  if (consensusReached) {
    logMessage(
      isEs
        ? `🎉 ¡Consenso alcanzado entre Gestor y Arquitecto! Solución aprobada.`
        : `🎉 Consensus reached between Manager and Architect! Solution approved.`,
    );
  }

  await session.upsertNode(
    {
      type: "SolutionState",
      properties: {
        appName: state.description.slice(0, 40) || "Solution",
        description: state.description,
        language: state.language,
        status: consensusReached ? "approved" : "planning",
        managerAgrees: state.managerAgrees,
        architectAgrees,
        iteration,
        // `null` clears it; `undefined` is skipped by the property merge and
        // would leave the resolved assumption's id in place — which the UI
        // reads to decide whether to show the validation banner.
        pendingAssumptionId: null,
        mode: state.mode ?? "initial",
      },
    },
    { actorId: "ai-architect" },
  );

  return {
    logs,
    architectAgrees,
    status: consensusReached ? "approved" : "planning",
  };
}

/**
 * A Task reaches the board through HAS_TASK and nothing else, so one that never
 * got its edge is surfaced rather than swallowed: it is a plan defect the human
 * can fix from the board, not a write that quietly did nothing.
 */
function reportUnlinkedTasks(
  session: PlannerSession,
  plan: PlannerPlan,
  idsByRef: Record<string, string>,
  isEs: boolean,
  logMessage: (text: string) => void,
): void {
  const taskIds = new Set(
    ofType(plan.nodes, "Task")
      .map((node) => node.id ?? idsByRef[node.ref])
      .filter((id): id is string => Boolean(id)),
  );
  if (taskIds.size === 0) return;

  const snapshot = session.snapshot();
  const linked = new Set(
    edgesOfType(snapshot, "HAS_TASK").map((edge) => edge.to),
  );
  const unlinked = nodesOfType(snapshot, "Task")
    .filter((node) => taskIds.has(node.id) && !linked.has(node.id))
    .map((node) => node.properties.title || node.id);

  if (unlinked.length > 0) {
    logMessage(
      isEs
        ? `⚠️ ${unlinked.length} tarea(s) sin Feature: ${unlinked.join(", ")}. Enlázalas desde el tablero.`
        : `⚠️ ${unlinked.length} task(s) with no Feature: ${unlinked.join(", ")}. Link them from the board.`,
    );
  }
}

async function runArchitectRevise(
  session: PlannerSession,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
  const isEs = state.language === "es";
  const iteration = state.iteration;
  const logs: AgentLog[] = [...state.logs];
  const model = getChatModel();
  const snapshot = session.snapshot();
  const dirty = dirtyNodes(snapshot);
  const revisionMarkdown = formatRevisionContext(snapshot);
  const graphMarkdown = snapshotToMarkdown(snapshot, {
    types: ["Epic", "Feature", "Assumption", "Risk", "Task", "C4DiagramElement"],
  });

  const logMessage = (text: string) => {
    logs.push({
      actor: "architect",
      text,
      at: new Date().toISOString(),
    });
  };

  logMessage(
    isEs
      ? `[Iteración ${iteration}] Arquitecto revisando ${dirty.length} nodo(s) sucio(s): C4, tareas y riesgos técnicos.`
      : `[Iteration ${iteration}] Architect reviewing ${dirty.length} dirty node(s): C4, tasks, and technical risks.`,
  );

  let plan: PlannerPlan | undefined;
  let architectAgrees = true;

  if (model) {
    try {
      const schema = await plannerPlanSchema("architect", isEs ? "es" : "en");
      const prompt = isEs
        ? `Eres un Arquitecto de Software (AI Architect). El usuario cambió nodos del plan. Revisa SOLO los nodos sucios y sus relaciones; adapta C4, tareas (puntos + 4 ejes, descripción con Qué y Cómo) y riesgos técnicos. No regeneres toda la arquitectura.

Grafo actual:
${graphMarkdown}

${revisionMarkdown}

Reglas:
- Para cambiar un nodo existente, inclúyelo en "nodes" con su "id" del grafo de arriba.
- Para crear uno nuevo, inclúyelo en "nodes" sin "id" y dale un "ref".
- Toda estructura va en "edges": una Task sin arista HAS_TASK desde su Feature no está en el plan. Los extremos son ids del grafo o refs de este mismo plan, nunca títulos.
- Para mover algo que ya existe, pon el id de la arista vieja en "removeEdges" y añade la nueva en "edges".
- Person / System / Boundary / Container / Component son tipos distintos. Boundary es solo agrupación; System es software. external:true se dibuja como Person_Ext / System_Ext / Container_Ext.
- agrees: true si la arquitectura revisada te parece completa.${formatUserReviewGuidance(state.reviewMessage, true)}`
        : `You are an AI Software Architect. The user changed nodes in the plan. Review ONLY the dirty nodes and their relationships; adapt C4, tasks (points + 4 axes, description with What and How), and technical risks. Do not regenerate the whole architecture.

Current graph:
${graphMarkdown}

${revisionMarkdown}

Rules:
- To change an existing node, include it in "nodes" with its "id" from the graph above.
- To create a new one, include it in "nodes" with no "id" and give it a "ref".
- All structure lives in "edges": a Task with no HAS_TASK edge from its Feature is not in the plan. Endpoints are graph ids or refs from this same plan — never titles.
- To move something that already exists, put the old edge's id in "removeEdges" and add the new one to "edges".
- Person / System / Boundary / Container / Component are distinct types. Boundary is grouping only; System is software. external:true renders as Person_Ext / System_Ext / Container_Ext.
- agrees: true when the revised architecture looks complete to you.${formatUserReviewGuidance(state.reviewMessage, false)}`;

      plan = await invokeArchitectStructured(
        session,
        model,
        schema,
        prompt,
        "architect_revision",
        isEs,
      );
      if (plan.review?.trim()) {
        logMessage(plan.review.trim());
      }
      architectAgrees = plan.agrees;
    } catch (err) {
      console.warn("LLM architect revise structured output error, falling back to deterministic:", err);
      plan = undefined;
    }
  }

  if (!plan) {
    plan = emptyPlan();
    const dirtyTask = nodesOfType(snapshot, "Task").find((n) => n.properties.dirty === true);
    const threatened =
      dirtyTask?.id ?? dirty.find((n) => n.type === "Feature" || n.type === "Epic")?.id;
    if (threatened) {
      const note = state.reviewMessage?.trim();
      const baseDescription = isEs
        ? "Los cambios del usuario pueden desactualizar estimaciones o el modelo C4."
        : "User changes may stale estimates or the C4 model.";
      plan.nodes.push({
        type: "Risk",
        ref: "revision-tech-risk",
        properties: {
          title: isEs ? "Impacto técnico del cambio de alcance" : "Technical impact of scope change",
          description: note
            ? `${baseDescription} ${isEs ? "Nota del usuario:" : "User note:"} ${note}`
            : baseDescription,
          severity: "medium",
          mitigation: isEs
            ? "Re-estimar tareas sucias y ajustar el C4 antes de implementar."
            : "Re-score dirty tasks and adjust C4 before implementation.",
        },
      });
      plan.edges.push({ type: "HAS_RISK", from: threatened, to: "revision-tech-risk" });
    }
    logMessage(
      isEs
        ? "Arquitectura y estimaciones revisadas frente a los nodos sucios."
        : "Architecture and estimates reviewed against dirty nodes.",
    );
  }

  plan = { ...plan, nodes: splitCombinedC4PlanNodes(plan.nodes) };

  // One atomic revision: a collaborator sees the whole adapted plan appear at
  // once, not a sequence of half-repaired intermediate states.
  const written = await applyPlan(session, plan, {
    actorId: "ai-architect",
    language: isEs ? "es" : "en",
    stamp: ARCHITECT_STAMP,
  });
  for (const dropped of written.droppedEdges) {
    logMessage(
      isEs
        ? `⚠️ Relación descartada (extremo desconocido): ${dropped}`
        : `⚠️ Dropped relationship (unknown endpoint): ${dropped}`,
    );
  }
  reportUnlinkedTasks(session, plan, written.idsByRef, isEs, logMessage);

  const consensusReached = state.managerAgrees && architectAgrees;

  if (architectAgrees) {
    logMessage(
      isEs
        ? "✅ Arquitecto aprueba la arquitectura y las tareas revisadas."
        : "✅ Architect approves the revised architecture and tasks.",
    );
  }

  if (consensusReached) {
    logMessage(
      isEs
        ? "🎉 Consenso alcanzado sobre los nodos revisados."
        : "🎉 Consensus reached on the revised nodes.",
    );
  }

  await session.upsertNode(
    {
      type: "SolutionState",
      properties: {
        appName: state.description.slice(0, 40) || "Solution",
        description: state.description,
        language: state.language,
        status: consensusReached ? "approved" : "planning",
        managerAgrees: state.managerAgrees,
        architectAgrees,
        iteration,
        pendingAssumptionId: null,
        mode: "revise",
      },
    },
    { actorId: "ai-architect" },
  );

  return {
    logs,
    architectAgrees,
    status: consensusReached ? "approved" : "planning",
    mode: "revise",
  };
}

import { snapshotToMarkdown } from "collabnode";
import { findOfType, nodesOfType, ofType, type PlannerSession } from "./session.ts";
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

import { getDeepAgentConfig } from "@collabnode/deepagents";
import { getPlannerWorkspaceType } from "./workspace-def.ts";
import { withActiveAgent } from "./activity.ts";

/**
 * Properties the Manager owns rather than the model: a Risk it raises is a
 * business risk, and an Assumption it raises is pending on the human it is
 * about to interrupt.
 */
/**
 * Written over whatever the model said, for every node of these types.
 *
 * `satisfies` is what keeps these honest: `category: "buisness"` used to be a
 * string the runtime rejected at write time; now it is not an enum member and
 * does not compile.
 */
const MANAGER_STAMP = {
  Risk: { category: "business" },
  Assumption: { status: "pending", raisedBy: "manager" },
} satisfies ApplyPlanOptions["stamp"];

export async function runManagerStep(
  session: PlannerSession,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
  return withActiveAgent(session, "manager", () => runManagerTurn(session, state));
}

async function runManagerTurn(
  session: PlannerSession,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
  if (state.mode === "revise") {
    return runManagerRevise(session, state);
  }

  const isEs = state.language === "es";
  const iteration = state.iteration + 1;
  const logs: AgentLog[] = [...state.logs];
  const model = getChatModel();
  const workspaceType = await getPlannerWorkspaceType();

  const logMessage = (text: string) => {
    logs.push({
      actor: "manager",
      text,
      at: new Date().toISOString(),
    });
  };

  const agentConfig = getDeepAgentConfig({
    session: session.as(),
    workspaceType,
    role: "manager",
    language: isEs ? "es" : "en",
    model: model ?? undefined,
  });

  logMessage(
    isEs
      ? `[Iteración ${iteration}] Gestor analizando requerimientos de negocio para: "${state.description}"`
      : `[Iteration ${iteration}] Manager analyzing business scope for: "${state.description}"`,
  );

  let plan: PlannerPlan = emptyPlan();

  if (model) {
    try {
      const schema = await plannerPlanSchema("manager", isEs ? "es" : "en");
      const prompt = isEs
        ? `Eres un Gerente de Producto (AI Manager). Analiza esta descripción de producto y devuelve un plan:
1. 2-3 Epics de negocio con 2 Features cada uno, como nodos con su propio "ref".
2. Una arista HAS_FEATURE por cada Feature, de la Épica a la que pertenece.
3. 1-2 Riesgos de negocio, cada uno con una arista HAS_RISK desde la Épica o Feature que amenaza.
4. Si es la primera iteración (iteración ${iteration} === 1), UNA suposición crítica (ej. proveedor cloud, autenticación, modelo de datos) para validar con el usuario humano, con una arista HAS_ASSUMPTION desde la Épica de la que depende. Si no es la primera iteración, no incluyas ninguna suposición.

Descripción: "${state.description}"`
        : `You are an AI Product Manager. Analyze this product description and return a plan:
1. 2-3 Business Epics with 2 Features each, as nodes with their own "ref".
2. One HAS_FEATURE edge per Feature, from the Epic it belongs to.
3. 1-2 Business Risks, each with a HAS_RISK edge from the Epic or Feature it threatens.
4. If iteration ${iteration} === 1, ONE critical assumption (e.g. cloud provider, auth provider, storage tier) for human validation, with a HAS_ASSUMPTION edge from the Epic it is load-bearing for. Otherwise raise no assumption.

Description: "${state.description}"`;

      const parsed = await invokeStructured(model, schema, prompt, "manager_plan", {
        system: agentConfig.systemPrompt,
      });
      plan = parsed;
      if (iteration !== 1) {
        plan = withoutAssumptions(plan);
      }
      if (plan.review?.trim()) {
        logMessage(plan.review.trim());
      }
    } catch (err) {
      console.warn("LLM manager structured output error, writing nothing:", err);
      logMessage(
        isEs
          ? "⚠️ El gestor no pudo generar un plan; no se escribió nada en el grafo."
          : "⚠️ Manager could not produce a plan; nothing was written to the graph.",
      );
      plan = emptyPlan();
    }
  }

  const written = await applyPlan(session, plan, {
    actorId: "ai-manager",
    language: isEs ? "es" : "en",
    stamp: MANAGER_STAMP,
  });
  for (const dropped of written.droppedEdges) {
    logMessage(
      isEs ? `⚠️ Relación descartada (extremo desconocido): ${dropped}` : `⚠️ Dropped relationship (unknown endpoint): ${dropped}`,
    );
  }

  // An Assumption in the plan is what pauses the workflow. Its id comes back
  // from the batch that wrote it — the plan's own `ref` is the only handle
  // that survives from composing the plan to acting on it.
  const assumption = findOfType(plan.nodes, "Assumption");
  const assumptionId = assumption ? written.idsByRef[assumption.ref] : undefined;

  if (assumptionId && !state.activeAssumptionId) {
    const title = String(assumption?.properties.title ?? "");
    logMessage(
      isEs
        ? `⚠️ [Suposición Crítica] "${title}". Pausando el flujo para validación humana.`
        : `⚠️ [Critical Assumption] "${title}". Pausing workflow for user validation.`,
    );

    await session.upsertNode(
      {
        type: "SolutionState",
        properties: {
          appName: state.description.slice(0, 40) || "Solution",
          description: state.description,
          language: state.language,
          status: "waiting_user_validation",
          managerAgrees: false,
          architectAgrees: state.architectAgrees,
          iteration,
          pendingAssumptionId: assumptionId,
          mode: state.mode ?? "initial",
        },
      },
      { actorId: "ai-manager" },
    );

    return {
      iteration,
      logs,
      activeAssumptionId: assumptionId,
      status: "waiting_user_validation",
      managerAgrees: false,
    };
  }

  // If the assumption was resolved, or we are on a later round, the Manager agrees.
  const managerAgrees = iteration >= 2 || !assumptionId;

  if (managerAgrees) {
    logMessage(
      isEs
        ? `✅ Gestor aprueba la definición de negocio y estructura de Epics.`
        : `✅ Manager approves business scope and Epic structure.`,
    );
  }

  await session.upsertNode(
    {
      type: "SolutionState",
      properties: {
        appName: state.description.slice(0, 40) || "Solution",
        description: state.description,
        language: state.language,
        status: managerAgrees && state.architectAgrees ? "approved" : "planning",
        managerAgrees,
        architectAgrees: state.architectAgrees,
        iteration,
        pendingAssumptionId: null,
        mode: state.mode ?? "initial",
      },
    },
    { actorId: "ai-manager" },
  );

  return {
    iteration,
    logs,
    status: managerAgrees && state.architectAgrees ? "approved" : "planning",
    managerAgrees,
  };
}

/** Later rounds do not re-raise an assumption: one pause per plan is the deal. */
function withoutAssumptions(plan: PlannerPlan): PlannerPlan {
  const dropped = new Set(
    ofType(plan.nodes, "Assumption").map((node) => node.ref),
  );
  if (dropped.size === 0) return plan;
  return {
    ...plan,
    nodes: plan.nodes.filter((node) => !dropped.has(node.ref)),
    edges: plan.edges.filter((edge) => !dropped.has(edge.from) && !dropped.has(edge.to)),
  };
}

async function runManagerRevise(
  session: PlannerSession,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
  const isEs = state.language === "es";
  const iteration = state.iteration + 1;
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
      actor: "manager",
      text,
      at: new Date().toISOString(),
    });
  };

  logMessage(
    isEs
      ? `[Iteración ${iteration}] Gestor revisando ${dirty.length} nodo(s) sucio(s) y sus relaciones.`
      : `[Iteration ${iteration}] Manager reviewing ${dirty.length} dirty node(s) and their relationships.`,
  );

  let plan: PlannerPlan | undefined;
  let managerAgrees = true;

  const workspaceType = await getPlannerWorkspaceType();
  const agentConfig = getDeepAgentConfig({
    session: session.as(),
    workspaceType,
    role: "manager",
    language: isEs ? "es" : "en",
    model: model ?? undefined,
  });

  if (model) {
    try {
      const schema = await plannerPlanSchema("manager", isEs ? "es" : "en");
      const prompt = isEs
        ? `Eres un Gerente de Producto (AI Manager). El usuario cambió nodos del plan. Revisa SOLO los nodos sucios y sus relaciones; adapta el alcance de negocio, no regeneres el plan completo.

Grafo actual:
${graphMarkdown}

${revisionMarkdown}

Reglas:
- Para cambiar un nodo existente, inclúyelo en "nodes" con su "id" del grafo de arriba.
- Para crear uno nuevo, inclúyelo en "nodes" sin "id" y dale un "ref".
- Toda estructura va en "edges": un Feature sin arista HAS_FEATURE no está en el plan. Los extremos son ids del grafo o refs de este mismo plan, nunca títulos.
- Para reparentar algo que ya existe, pon el id de la arista vieja en "removeEdges" y añade la nueva en "edges".
- Plantea UNA suposición solo si el cambio es crítico y aún no hay una pendiente.
- agrees: true si el alcance revisado te parece completo.${formatUserReviewGuidance(state.reviewMessage, true)}`
        : `You are an AI Product Manager. The user changed nodes in the plan. Review ONLY the dirty nodes and their relationships; adapt business scope — do not regenerate the whole plan.

Current graph:
${graphMarkdown}

${revisionMarkdown}

Rules:
- To change an existing node, include it in "nodes" with its "id" from the graph above.
- To create a new one, include it in "nodes" with no "id" and give it a "ref".
- All structure lives in "edges": a Feature with no HAS_FEATURE edge is not in the plan. Endpoints are graph ids or refs from this same plan — never titles.
- To re-parent something that already exists, put the old edge's id in "removeEdges" and add the new one to "edges".
- Raise ONE assumption only if the change is load-bearing and none is already pending.
- agrees: true when the revised scope looks complete to you.${formatUserReviewGuidance(state.reviewMessage, false)}`;

      const parsed = await invokeStructured(model, schema, prompt, "manager_revision", {
        system: agentConfig.systemPrompt,
      });
      plan = parsed;
      if (plan.review?.trim()) {
        logMessage(plan.review.trim());
      }
      managerAgrees = plan.agrees;
    } catch (err) {
      console.warn("LLM manager revise structured output error, falling back to deterministic:", err);
      plan = undefined;
    }
  }

  if (!plan) {
    plan = emptyPlan();
    const dirtyEpic = nodesOfType(snapshot, "Epic").find((n) => n.properties.dirty === true);
    if (dirtyEpic) {
      const note = state.reviewMessage?.trim();
      const baseDescription = isEs
        ? `El usuario modificó "${String(dirtyEpic.properties.title)}". Hay que revalidar Features, tareas y riesgos asociados.`
        : `The user changed "${String(dirtyEpic.properties.title)}". Linked features, tasks, and risks need revalidation.`;
      plan.nodes.push({
        type: "Risk",
        ref: "revision-risk",
        properties: {
          title: isEs ? "Cambio de alcance pendiente de alinear" : "Scope change needs alignment",
          description: note
            ? `${baseDescription} ${isEs ? "Nota del usuario:" : "User note:"} ${note}`
            : baseDescription,
          severity: "medium",
          mitigation: isEs
            ? "Revisar descendientes del Epic y ajustar el plan antes de implementar."
            : "Review the Epic's descendants and adjust the plan before implementation.",
        },
      });
      // The Epic is already in the graph, so the edge names it by id.
      plan.edges.push({ type: "HAS_RISK", from: dirtyEpic.id, to: "revision-risk" });
      logMessage(
        isEs
          ? `Adaptando el alcance de "${String(dirtyEpic.properties.title)}" y registrando un riesgo de negocio.`
          : `Adapting scope for "${String(dirtyEpic.properties.title)}" and recording a business risk.`,
      );
    } else {
      logMessage(
        isEs
          ? "Revisión de negocio completada: sin cambios estructurales adicionales."
          : "Business review complete: no extra structural changes.",
      );
    }
  }

  const written = await applyPlan(session, plan, {
    actorId: "ai-manager",
    language: isEs ? "es" : "en",
    stamp: MANAGER_STAMP,
  });
  for (const dropped of written.droppedEdges) {
    logMessage(
      isEs ? `⚠️ Relación descartada (extremo desconocido): ${dropped}` : `⚠️ Dropped relationship (unknown endpoint): ${dropped}`,
    );
  }

  const assumption = findOfType(plan.nodes, "Assumption", (node) => !node.id);
  const assumptionId = assumption ? written.idsByRef[assumption.ref] : undefined;

  if (assumptionId && !state.activeAssumptionId) {
    logMessage(
      isEs
        ? `⚠️ [Suposición Crítica] "${String(assumption?.properties.title ?? "")}". Pausando el flujo para validación humana.`
        : `⚠️ [Critical Assumption] "${String(assumption?.properties.title ?? "")}". Pausing workflow for user validation.`,
    );

    await session.upsertNode(
      {
        type: "SolutionState",
        properties: {
          appName: state.description.slice(0, 40) || "Solution",
          description: state.description,
          language: state.language,
          status: "waiting_user_validation",
          managerAgrees: false,
          architectAgrees: state.architectAgrees,
          iteration,
          pendingAssumptionId: assumptionId,
          mode: "revise",
        },
      },
      { actorId: "ai-manager" },
    );

    return {
      iteration,
      logs,
      activeAssumptionId: assumptionId,
      status: "waiting_user_validation",
      managerAgrees: false,
      mode: "revise",
    };
  }

  const verdict = {
    agreed: isEs ? "✅ Gestor aprueba el alcance revisado." : "✅ Manager approves the revised scope.",
    open: isEs
      ? "El Gestor aún ve trabajo pendiente en el alcance."
      : "Manager still sees open work in the scope.",
  };
  logMessage(managerAgrees ? verdict.agreed : verdict.open);

  await session.upsertNode(
    {
      type: "SolutionState",
      properties: {
        appName: state.description.slice(0, 40) || "Solution",
        description: state.description,
        language: state.language,
        status: managerAgrees && state.architectAgrees ? "approved" : "planning",
        managerAgrees,
        architectAgrees: state.architectAgrees,
        iteration,
        pendingAssumptionId: null,
        mode: "revise",
      },
    },
    { actorId: "ai-manager" },
  );

  return {
    iteration,
    logs,
    status: managerAgrees && state.architectAgrees ? "approved" : "planning",
    managerAgrees,
    mode: "revise",
  };
}

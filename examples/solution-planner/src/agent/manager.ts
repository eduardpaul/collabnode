import type { CollabSession } from "@collabnode/runtime";
import { snapshotToMarkdown } from "collabnode";
import type { PlannerState, AgentLog } from "./types.ts";
import { getChatModel, invokeStructured } from "./llm.ts";
import {
  applyRevisionWrites,
  dirtyNodes,
  formatRevisionContext,
  formatUserReviewGuidance,
  risksToCreates,
  type RevisionCreate,
  type RevisionUpdate,
} from "./dirty.ts";
import { managerPlanSchema, managerRevisionSchema, omitNullish } from "./schemas.ts";

export async function runManagerStep(
  session: CollabSession,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
  if (state.mode === "revise") {
    return runManagerRevise(session, state);
  }

  const isEs = state.language === "es";
  const iteration = state.iteration + 1;
  const logs: AgentLog[] = [...state.logs];
  const model = getChatModel();

  const logMessage = (text: string) => {
    logs.push({
      actor: "manager",
      text,
      at: new Date().toISOString(),
    });
  };

  logMessage(
    isEs
      ? `[Iteración ${iteration}] Gestor analizando requerimientos de negocio para: "${state.description}"`
      : `[Iteration ${iteration}] Manager analyzing business scope for: "${state.description}"`,
  );

  let epics: Array<{ title: string; description: string; priority: "low" | "medium" | "high"; features: Array<{ title: string; description: string }> }> = [];
  let businessRisks: Array<{ title: string; description: string; severity: "low" | "medium" | "high" | "critical"; mitigation: string }> = [];
  let newAssumption: { title: string; description: string } | null = null;

  if (model) {
    try {
      const prompt = isEs
        ? `Eres un Gerente de Producto (AI Manager). Analiza esta descripción de producto y genera:
1. 2-3 Epics de negocio con 2 Features cada uno.
2. 1-2 Riesgos de negocio con severidad y mitigación.
3. Si es la primera iteración (iteración ${iteration} === 1), plantea UNA suposición clave (ej. proveedor cloud, autenticación, modelo de datos) para validar con el usuario humano. Si no es la primera iteración, assumption debe ser null.

Descripción: "${state.description}"`
        : `You are an AI Product Manager. Analyze this product description and produce:
1. 2-3 Business Epics with 2 Features each.
2. 1-2 Business Risks with severity and mitigation.
3. If iteration ${iteration} === 1, raise ONE critical assumption (e.g. cloud provider, auth provider, storage tier) for human validation. Otherwise assumption must be null.

Description: "${state.description}"`;

      const parsed = await invokeStructured(model, managerPlanSchema, prompt, "manager_plan");
      epics = parsed.epics;
      businessRisks = parsed.businessRisks;
      if (iteration === 1) {
        newAssumption = parsed.assumption ?? {
          title: isEs ? "Asumir Infraestructura Cloud Híbrida" : "Assume Cloud & Security Tier",
          description: isEs
            ? "¿Aceptas asumir despliegue en nube con autenticación OIDC y cifrado en tránsito?"
            : "Do you approve assuming cloud deployment with OIDC authentication and transit encryption?",
        };
      }
    } catch (err) {
      console.warn("LLM manager structured output error, falling back to deterministic:", err);
      epics = [];
    }
  }

  // Deterministic fallback if model was not configured or errored
  if (epics.length === 0) {
    if (isEs) {
      epics = [
        {
          title: "Colaboración en Tiempo Real",
          description: "Infraestructura y sincronización para edición multi-usuario sin conflictos.",
          priority: "high",
          features: [
            {
              title: "Sincronización de Estado CRDT",
              description: "Propagación bidireccional y resolución determinista de conflictos en memoria y red.",
            },
            {
              title: "Presencia y Concurrencia de Usuarios",
              description: "Detección de pares activos, avatares y cursores en vivo.",
            },
          ],
        },
        {
          title: "Gestión y Persistencia de la Solución",
          description: "Estructura de datos para modelar épicas, tareas y grafos de decisión.",
          priority: "medium",
          features: [
            {
              title: "Exportación y Proyección de Grafos",
              description: "Visualización interactiva y consulta semántica de dependencias.",
            },
            {
              title: "Registro de Historial y Auditoría",
              description: "Trazabilidad de cambios por usuario y agente en cada iteración.",
            },
          ],
        },
      ];

      businessRisks = [
        {
          title: "Sobrecarga de Red por Alta Concurrencia",
          description: "Múltiples agentes y usuarios editando simultáneamente pueden saturar el canal de eventos.",
          severity: "medium",
          mitigation: "Agrupar mutaciones en lotes y utilizar debouncing en la proyección de almacenamiento.",
        },
      ];

      if (iteration === 1) {
        newAssumption = {
          title: "Asumir Infraestructura Redis + Fluid Relay",
          description: "¿Podemos asumir el uso de Redis para registro distribuido y Fluid Framework para la sincronización de sesión?",
        };
      }
    } else {
      epics = [
        {
          title: "Real-Time Multi-Peer Collaboration",
          description: "Core collaborative engine for conflict-free distributed editing between humans and agents.",
          priority: "high",
          features: [
            {
              title: "CRDT State Synchronization",
              description: "Bidirectional mutation propagation and deterministic merging over WebSockets.",
            },
            {
              title: "Peer Awareness & Live Presence",
              description: "Tracking connected actors, typing indicators, and active session leases.",
            },
          ],
        },
        {
          title: "Solution Graph Persistence & Projection",
          description: "Declarative graph schema storing business epics, architecture nodes, and tasks.",
          priority: "medium",
          features: [
            {
              title: "Interactive Graph Visualization",
              description: "Live visual projection of solution components and cross-entity relationships.",
            },
            {
              title: "Audit Trail & Change Tracking",
              description: "Fine-grained provenance and history records for all agent and user operations.",
            },
          ],
        },
      ];

      businessRisks = [
        {
          title: "Network Saturation Under High Agent Concurrency",
          description: "Rapid cyclical mutations from multiple agents could degrade browser responsiveness.",
          severity: "medium",
          mitigation: "Apply batch operations (applyOps) and debounce projection updates.",
        },
      ];

      if (iteration === 1) {
        newAssumption = {
          title: "Assume Redis Registry and Fluid Relay Backbone",
          description: "Should we assume Redis for cross-replica workspace registry and Fluid Framework for CRDT session relay?",
        };
      }
    }
  }

  // Mutate collabnode session atomically via session.batch()
  await session.batch(
    (b) => {
      let epicIndex = 0;
      for (const epic of epics) {
        const epicRef = `epic-${epicIndex++}`;
        b.upsertNode(
          {
            type: "Epic",
            properties: {
              title: epic.title,
              description: epic.description,
              priority: epic.priority,
              dirty: false,
            },
          },
          epicRef,
        );

        let featIndex = 0;
        for (const feat of epic.features) {
          const featRef = `${epicRef}-feat-${featIndex++}`;
          b.upsertNode(
            {
              type: "Feature",
              properties: {
                title: feat.title,
                description: feat.description,
                epicTitle: epic.title,
                dirty: false,
              },
            },
            featRef,
          );

          b.upsertEdge({
            type: "HAS_FEATURE",
            from: { ref: epicRef },
            to: { ref: featRef },
          });
        }
      }

      for (const risk of businessRisks) {
        b.upsertNode({
          type: "Risk",
          properties: {
            title: risk.title,
            description: risk.description,
            severity: risk.severity,
            category: "business",
            mitigation: risk.mitigation,
            dirty: false,
          },
        });
      }
    },
    { actorId: "ai-manager" },
  );

  // If a new assumption is flagged, raise it and trigger Human-In-The-Loop pause
  let activeAssumptionId = state.activeAssumptionId;
  let status: PlannerState["status"] = "planning";

  if (newAssumption && !state.activeAssumptionId) {
    const assumptionId = await session.upsertNode(
      {
        type: "Assumption",
        properties: {
          title: newAssumption.title,
          description: newAssumption.description,
          status: "pending",
          raisedBy: "manager",
          dirty: false,
        },
      },
      { actorId: "ai-manager" },
    );

    activeAssumptionId = assumptionId;
    status = "waiting_user_validation";

    logMessage(
      isEs
        ? `⚠️ [Suposición Crítica] "${newAssumption.title}". Pausando el flujo para validación humana.`
        : `⚠️ [Critical Assumption] "${newAssumption.title}". Pausing workflow for user validation.`,
    );

    // Update solution state in collabnode
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
      activeAssumptionId,
      status,
      managerAgrees: false,
    };
  }

  // If assumption was resolved or we are on subsequent rounds, mark Manager agreement
  const managerAgrees = iteration >= 2 || !newAssumption;

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
        pendingAssumptionId: undefined,
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

async function runManagerRevise(
  session: CollabSession,
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
    types: ["Epic", "Feature", "Assumption", "Risk", "Task", "C4Model"],
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

  let updates: RevisionUpdate[] = [];
  let creates: RevisionCreate[] = [];
  let newAssumption: { title: string; description: string } | null = null;
  let managerAgrees = true;
  let usedModel = false;

  if (model) {
    try {
      const prompt = isEs
        ? `Eres un Gerente de Producto (AI Manager). El usuario cambió nodos del plan. Revisa SOLO los nodos sucios y sus relaciones; adapta el alcance de negocio, no regeneres el plan completo.

Grafo actual:
${graphMarkdown}

${revisionMarkdown}

Reglas:
- Actualiza nodos existentes por id.
- Crea Features/Riesgos solo si el cambio lo exige.
- Plantea UNA suposición solo si el cambio es crítico y aún no hay una pendiente.
- dirty debe quedar limpio en tus escrituras (el runtime lo fuerza).${formatUserReviewGuidance(state.reviewMessage, true)}`
        : `You are an AI Product Manager. The user changed nodes in the plan. Review ONLY the dirty nodes and their relationships; adapt business scope — do not regenerate the whole plan.

Current graph:
${graphMarkdown}

${revisionMarkdown}

Rules:
- Update existing nodes by id.
- Create Features/Risks only when the change requires it.
- Raise ONE assumption only if the change is load-bearing and none is already pending.
- Your writes are stamped clean (not dirty).${formatUserReviewGuidance(state.reviewMessage, false)}`;

      const parsed = await invokeStructured(model, managerRevisionSchema, prompt, "manager_revision");
      if (parsed.review.trim()) {
        logMessage(parsed.review.trim());
      }
      updates = parsed.updates.map((update) => ({
        id: update.id,
        properties: omitNullish(update.properties),
      }));
      creates = [
        ...parsed.creates.map((create) => ({
          type: create.type,
          properties: omitNullish(create.properties),
          link: create.link ?? undefined,
        })),
        ...risksToCreates(parsed.risks),
      ];
      if (parsed.assumption?.title.trim()) {
        newAssumption = {
          title: parsed.assumption.title.trim(),
          description: parsed.assumption.description.trim(),
        };
      }
      managerAgrees = parsed.agrees;
      usedModel = true;
    } catch (err) {
      console.warn("LLM manager revise structured output error, falling back to deterministic:", err);
    }
  }

  if (!usedModel) {
    const dirtyEpic = snapshot.nodes.find((n) => n.type === "Epic" && n.properties.dirty === true);
    if (dirtyEpic) {
      const note = state.reviewMessage?.trim();
      const baseDescription = isEs
        ? `El usuario modificó "${String(dirtyEpic.properties.title)}". Hay que revalidar Features, tareas y riesgos asociados.`
        : `The user changed "${String(dirtyEpic.properties.title)}". Linked features, tasks, and risks need revalidation.`;
      creates.push({
        type: "Risk",
        properties: {
          title: isEs ? "Cambio de alcance pendiente de alinear" : "Scope change needs alignment",
          description: note
            ? `${baseDescription} ${isEs ? "Nota del usuario:" : "User note:"} ${note}`
            : baseDescription,
          severity: "medium",
          category: "business",
          mitigation: isEs
            ? "Revisar descendientes del Epic y ajustar el plan antes de implementar."
            : "Review the Epic's descendants and adjust the plan before implementation.",
        },
        link: { type: "HAS_RISK", from: dirtyEpic.id },
      });
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

  await applyRevisionWrites(session, { updates, creates }, "ai-manager");

  let activeAssumptionId = state.activeAssumptionId;
  let status: PlannerState["status"] = "planning";

  if (newAssumption && !state.activeAssumptionId) {
    const assumptionId = await session.upsertNode(
      {
        type: "Assumption",
        properties: {
          title: newAssumption.title,
          description: newAssumption.description,
          status: "pending",
          raisedBy: "manager",
          dirty: false,
        },
      },
      { actorId: "ai-manager" },
    );

    activeAssumptionId = assumptionId;
    status = "waiting_user_validation";
    managerAgrees = false;

    logMessage(
      isEs
        ? `⚠️ [Suposición Crítica] "${newAssumption.title}". Pausando el flujo para validación humana.`
        : `⚠️ [Critical Assumption] "${newAssumption.title}". Pausing workflow for user validation.`,
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
      activeAssumptionId,
      status,
      managerAgrees: false,
      mode: "revise",
    };
  }

  if (managerAgrees) {
    logMessage(
      isEs
        ? "✅ Gestor aprueba el alcance de negocio revisado."
        : "✅ Manager approves the revised business scope.",
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
        pendingAssumptionId: undefined,
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

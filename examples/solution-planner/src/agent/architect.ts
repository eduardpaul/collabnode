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
import { architectPlanSchema, architectRevisionSchema, omitNullish } from "./schemas.ts";

export async function runArchitectStep(
  session: CollabSession,
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
      ? `[Iteración ${iteration}] Arquitecto diseñando modelo C4 y descomposición de tareas con estimación de 6 ejes.`
      : `[Iteration ${iteration}] Architect designing C4 model and 6-axis task breakdown.`,
  );

  // Read current snapshot from shared collab session
  const snapshot = session.snapshot();
  const epics = snapshot.nodes.filter((n) => n.type === "Epic");
  const features = snapshot.nodes.filter((n) => n.type === "Feature");

  let c4Models: Array<{ title: string; level: "context" | "container" | "component"; markdown: string }> = [];
  let tasks: Array<{
    title: string;
    description: string;
    featureTitle: string;
    functionalPoints: string;
    technicalPoints: string;
    complexity: number;
    uncertainty: number;
    friction: number;
    nfrScale: number;
    status: "todo" | "doing" | "done";
  }> = [];
  let techRisks: Array<{ title: string; description: string; severity: "low" | "medium" | "high" | "critical"; mitigation: string }> = [];

  const contextMarkdown = snapshotToMarkdown(snapshot, {
    types: ["Epic", "Feature", "Assumption", "Risk"],
  });

  if (model) {
    try {
      const prompt = isEs
        ? `Eres un Arquitecto de Software (AI Architect). Analiza el alcance de la solución definido por el Gestor:

${contextMarkdown}

Genera:
1. Un modelo C4 en Markdown conciso (niveles Contexto y Contenedor).
2. Tareas técnicas accionables para las features, estimadas estrictamente en los 6 EJES:
   - functionalPoints: El 'Qué' (valor de negocio / flujo de usuario).
   - technicalPoints: El 'Cómo' (infraestructura, deuda técnica, integraciones).
   - complexity: número 0 (Trivial) a 5 (Reforma masiva).
   - uncertainty: número 0 (Hecho 100 veces) a 5 (I+D puro).
   - friction: número 0 (Solo) a 5 (Coordinación pesada).
   - nfrScale: número 0 (Bajo/Interno) a 3 (Extrema escala/cumplimiento).
3. 1-2 Riesgos técnicos con severidad y mitigación.`
        : `You are an AI Software Architect. Review the business scope and features defined for this solution:

${contextMarkdown}

Produce:
1. Minimal C4 architecture markdown (Context & Container levels).
2. Actionable technical tasks scored on the 6-AXIS FRAMEWORK:
   - functionalPoints: The 'What' (business value / user journey).
   - technicalPoints: The 'How' (infrastructure, tech debt, integrations).
   - complexity: number 0 (Trivial) to 5 (Massive overhaul).
   - uncertainty: number 0 (Done 100x) to 5 (Pure R&D).
   - friction: number 0 (Solo work) to 5 (Heavy cross-team coordination).
   - nfrScale: number 0 (Low/Internal) to 3 (Extreme compliance/scale).
3. 1-2 Technical Risks with severity and mitigation.`;

      const parsed = await invokeStructured(model, architectPlanSchema, prompt, "architect_plan");
      c4Models = parsed.c4Models;
      tasks = parsed.tasks;
      techRisks = parsed.techRisks;
    } catch (err) {
      console.warn("LLM architect structured output error, falling back to deterministic:", err);
      c4Models = [];
    }
  }

  // Deterministic fallback if model was not configured or errored
  if (c4Models.length === 0) {
    if (isEs) {
      c4Models = [
        {
          title: "Diagrama de Contenedores C4",
          level: "container",
          markdown: `\`\`\`mermaid
flowchart TD
  User([👤 Usuario / Navegador])
  UI[⚛️ React Frontend (Vite + Web)]
  Hub[🌐 Collabnode Hub / API Node.js]
  Fluid[⚡ Fluid Relay / CRDT Store]
  Redis[(🗄️ Redis Registry & Leases)]

  User -->|HTTPS / WSS| UI
  UI -->|CRDT Ops| Fluid
  UI -->|REST / MCP| Hub
  Hub -->|Coordina leases| Redis
  Hub -->|Proyección Grafos| Fluid
\`\`\``,
        },
      ];

      tasks = [
        {
          title: "Implementar Conexión React useCollab",
          description: "Vincular el estado del árbol de componentes al ciclo de vida del CollabSession.",
          featureTitle: "Sincronización de Estado CRDT",
          functionalPoints: "Renderizado reactivo inmediato ante mutaciones remotas",
          technicalPoints: "Subscripción via useSyncExternalStore y onChange",
          complexity: 2,
          uncertainty: 1,
          friction: 1,
          nfrScale: 1,
          status: "todo",
        },
        {
          title: "Configurar Servidor Hub con Memoria / Redis",
          description: "Montar el punto de entrada de Collabnode Hub y endpoints REST para la UI.",
          featureTitle: "Gestión y Persistencia de la Solución",
          functionalPoints: "Gestión transparente de sesiones y documentos",
          technicalPoints: "openCollab() + memoryRegistry/redisRegistry",
          complexity: 2,
          uncertainty: 1,
          friction: 0,
          nfrScale: 2,
          status: "todo",
        },
        {
          title: "Construir Loop Cíclico en LangGraph con Interrupciones",
          description: "Orquestar el intercambio entre AI Manager y AI Architect con pausa para validación de suposiciones.",
          featureTitle: "Registro de Historial y Auditoría",
          functionalPoints: "Co-creación guiada de soluciones con control humano",
          technicalPoints: "StateGraph con MemorySaver y validación condicional",
          complexity: 3,
          uncertainty: 2,
          friction: 1,
          nfrScale: 1,
          status: "todo",
        },
      ];

      techRisks = [
        {
          title: "Latencia de Replicación de Estado en Red Débil",
          description: "La sincronización de grafos complejos puede experimentar demoras temporales de convergencia.",
          severity: "low",
          mitigation: "Aprovechar la resolución LWW y la proyección desacoplada de Collabnode.",
        },
      ];
    } else {
      c4Models = [
        {
          title: "C4 Container Diagram",
          level: "container",
          markdown: `\`\`\`mermaid
flowchart TD
  User([👤 User / Browser])
  UI[⚛️ React Frontend (Vite + Web)]
  Hub[🌐 Collabnode Hub / Node.js API]
  Fluid[⚡ Fluid Relay / CRDT Backbone]
  Redis[(🗄️ Redis Registry & Leases)]

  User -->|HTTPS / WSS| UI
  UI -->|CRDT Ops| Fluid
  UI -->|REST / MCP| Hub
  Hub -->|Coordinate Leases| Redis
  Hub -->|Project Graph| Fluid
\`\`\``,
        },
      ];

      tasks = [
        {
          title: "Implement useCollab React Hook Binding",
          description: "Bind React component tree reactively to the CollabSession lifecycle.",
          featureTitle: "CRDT State Synchronization",
          functionalPoints: "Instant UI updates upon receiving remote peer mutations",
          technicalPoints: "Integration via useSyncExternalStore and session.onChange",
          complexity: 2,
          uncertainty: 1,
          friction: 1,
          nfrScale: 1,
          status: "todo",
        },
        {
          title: "Configure Hub Server with Fluid & Redis",
          description: "Set up Collabnode Hub backend with API routes and workspace definitions.",
          featureTitle: "Solution Graph Persistence & Projection",
          functionalPoints: "Unified document joining and idempotent session creation",
          technicalPoints: "openCollab() + memoryRegistry/redisRegistry",
          complexity: 2,
          uncertainty: 1,
          friction: 0,
          nfrScale: 2,
          status: "todo",
        },
        {
          title: "Build Cyclic LangGraph Multi-Agent Workflow",
          description: "Orchestrate Manager and Architect turns with human-in-the-loop assumption pauses.",
          featureTitle: "Audit Trail & Change Tracking",
          functionalPoints: "Autonomous co-planning with guaranteed user oversight",
          technicalPoints: "StateGraph with checkpointing and interrupt edges",
          complexity: 3,
          uncertainty: 2,
          friction: 1,
          nfrScale: 1,
          status: "todo",
        },
      ];

      techRisks = [
        {
          title: "State Replication Lag on Constrained Networks",
          description: "Large graph operations might take several hundred milliseconds to converge.",
          severity: "low",
          mitigation: "Leverage Collabnode's debounced projection and LWW conflict resolution.",
        },
      ];
    }
  }

  // Mutate collabnode session atomically via session.batch()
  await session.batch(
    (b) => {
      for (const c4 of c4Models) {
        b.upsertNode({
          type: "C4Model",
          properties: {
            title: c4.title,
            level: c4.level,
            markdown: c4.markdown,
            dirty: false,
          },
        });
      }

      let taskIndex = 0;
      for (const task of tasks) {
        const taskRef = `task-${taskIndex++}`;
        b.upsertNode(
          {
            type: "Task",
            properties: {
              title: task.title,
              description: task.description,
              featureTitle: task.featureTitle,
              functionalPoints: task.functionalPoints,
              technicalPoints: task.technicalPoints,
              complexity: task.complexity,
              uncertainty: task.uncertainty,
              friction: task.friction,
              nfrScale: task.nfrScale,
              status: task.status,
              dirty: false,
            },
          },
          taskRef,
        );

        // Link task to its feature if found
        const matchingFeature = features.find((f) => f.properties.title === task.featureTitle);
        if (matchingFeature) {
          b.upsertEdge({
            type: "HAS_TASK",
            from: matchingFeature.id,
            to: { ref: taskRef },
          });
        }
      }

      for (const risk of techRisks) {
        b.upsertNode({
          type: "Risk",
          properties: {
            title: risk.title,
            description: risk.description,
            severity: risk.severity,
            category: "technical",
            mitigation: risk.mitigation,
            dirty: false,
          },
        });
      }
    },
    { actorId: "ai-architect" },
  );

  const architectAgrees = true;

  logMessage(
    isEs
      ? `✅ Arquitecto aprueba la arquitectura técnica y el desglose de tareas (6 ejes).`
      : `✅ Architect approves technical architecture and 6-axis task estimation.`,
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
        pendingAssumptionId: undefined,
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

async function runArchitectRevise(
  session: CollabSession,
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
    types: ["Epic", "Feature", "Assumption", "Risk", "Task", "C4Model"],
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

  let updates: RevisionUpdate[] = [];
  let creates: RevisionCreate[] = [];
  let architectAgrees = true;
  let usedModel = false;

  if (model) {
    try {
      const prompt = isEs
        ? `Eres un Arquitecto de Software (AI Architect). El usuario cambió nodos del plan. Revisa SOLO los nodos sucios y sus relaciones; adapta C4, tareas (6 ejes) y riesgos técnicos. No regeneres toda la arquitectura.

Grafo actual:
${graphMarkdown}

${revisionMarkdown}

Reglas:
- Actualiza nodos existentes por id.
- Crea Tasks/C4/Riesgos solo si el cambio lo exige.
- Enlaza Tasks a Features con HAS_TASK y a C4 con TARGETS_C4 cuando aplique.${formatUserReviewGuidance(state.reviewMessage, true)}`
        : `You are an AI Software Architect. The user changed nodes in the plan. Review ONLY the dirty nodes and their relationships; adapt C4, 6-axis tasks, and technical risks. Do not regenerate the whole architecture.

Current graph:
${graphMarkdown}

${revisionMarkdown}

Rules:
- Update existing nodes by id.
- Create Tasks/C4/Risks only when the change requires it.
- Link Tasks to Features with HAS_TASK and to C4 with TARGETS_C4 when relevant.${formatUserReviewGuidance(state.reviewMessage, false)}`;

      const parsed = await invokeStructured(model, architectRevisionSchema, prompt, "architect_revision");
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
      architectAgrees = parsed.agrees;
      usedModel = true;
    } catch (err) {
      console.warn("LLM architect revise structured output error, falling back to deterministic:", err);
    }
  }

  if (!usedModel) {
    const dirtyTask = snapshot.nodes.find((n) => n.type === "Task" && n.properties.dirty === true);
    const linkFrom =
      dirtyTask?.id ?? dirty.find((n) => n.type === "Feature" || n.type === "Epic")?.id;
    if (linkFrom) {
      const note = state.reviewMessage?.trim();
      const baseDescription = isEs
        ? "Los cambios del usuario pueden desactualizar estimaciones de 6 ejes o el modelo C4."
        : "User changes may stale 6-axis estimates or the C4 model.";
      creates.push({
        type: "Risk",
        properties: {
          title: isEs ? "Impacto técnico del cambio de alcance" : "Technical impact of scope change",
          description: note
            ? `${baseDescription} ${isEs ? "Nota del usuario:" : "User note:"} ${note}`
            : baseDescription,
          severity: "medium",
          category: "technical",
          mitigation: isEs
            ? "Re-estimar tareas sucias y ajustar el C4 antes de implementar."
            : "Re-score dirty tasks and adjust C4 before implementation.",
        },
        link: { type: "HAS_RISK", from: linkFrom },
      });
    }
    logMessage(
      isEs
        ? "Arquitectura y estimaciones revisadas frente a los nodos sucios."
        : "Architecture and estimates reviewed against dirty nodes.",
    );
  }

  await applyRevisionWrites(session, { updates, creates }, "ai-architect");

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
        pendingAssumptionId: undefined,
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

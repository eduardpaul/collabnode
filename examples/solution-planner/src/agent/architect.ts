import type { CollabSession } from "@collabnode/runtime";
import { snapshotToMarkdown } from "collabnode";
import type { PlannerState, AgentLog } from "./types.ts";
import { getChatModel } from "./llm.ts";
import { extractJson } from "./json.ts";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export async function runArchitectStep(
  session: CollabSession,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
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
3. 1-2 Riesgos técnicos con severidad y mitigación.

Responde en JSON con esta estructura:
{
  "c4Models": [{"title": "...", "level": "container", "markdown": "..."}],
  "tasks": [{
    "title": "...",
    "description": "...",
    "featureTitle": "...",
    "functionalPoints": "...",
    "technicalPoints": "...",
    "complexity": 2,
    "uncertainty": 1,
    "friction": 1,
    "nfrScale": 1,
    "status": "todo"
  }],
  "techRisks": [{"title": "...", "description": "...", "severity": "high", "mitigation": "..."}]
}`
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
3. 1-2 Technical Risks with severity and mitigation.

Respond in JSON with this structure:
{
  "c4Models": [{"title": "...", "level": "container", "markdown": "..."}],
  "tasks": [{
    "title": "...",
    "description": "...",
    "featureTitle": "...",
    "functionalPoints": "...",
    "technicalPoints": "...",
    "complexity": 2,
    "uncertainty": 1,
    "friction": 1,
    "nfrScale": 1,
    "status": "todo"
  }],
  "techRisks": [{"title": "...", "description": "...", "severity": "high", "mitigation": "..."}]
}`;

      const res = await model.invoke([
        new SystemMessage(isEs ? "Responde únicamente en JSON válido." : "Respond only with valid JSON."),
        new HumanMessage(prompt),
      ]);

      const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      const parsed = extractJson(text);
      c4Models = Array.isArray(parsed.c4Models) ? parsed.c4Models : [];
      tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      techRisks = Array.isArray(parsed.techRisks) ? parsed.techRisks : [];
    } catch (err) {
      console.warn("LLM architect parsing error, falling back to deterministic:", err);
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

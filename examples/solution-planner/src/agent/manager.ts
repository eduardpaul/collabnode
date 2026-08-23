import type { CollabSession } from "@collabnode/runtime";
import type { PlannerState, AgentLog } from "./types.ts";
import { getChatModel } from "./llm.ts";
import { extractJson } from "./json.ts";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export async function runManagerStep(
  session: CollabSession,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
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
3. Si es la primera iteración (iteración ${iteration} === 1), plantea UNA suposición clave (ej. proveedor cloud, autenticación, modelo de datos) para validar con el usuario humano.

Descripción: "${state.description}"

Responde en JSON con esta estructura:
{
  "epics": [{"title": "...", "description": "...", "priority": "high", "features": [{"title": "...", "description": "..."}]}],
  "businessRisks": [{"title": "...", "description": "...", "severity": "medium", "mitigation": "..."}],
  "assumption": {"title": "...", "description": "..."} // o null si no hay nueva
}`
        : `You are an AI Product Manager. Analyze this product description and produce:
1. 2-3 Business Epics with 2 Features each.
2. 1-2 Business Risks with severity and mitigation.
3. If iteration ${iteration} === 1, raise ONE critical assumption (e.g. cloud provider, auth provider, storage tier) for human validation.

Description: "${state.description}"

Respond in JSON with this structure:
{
  "epics": [{"title": "...", "description": "...", "priority": "high", "features": [{"title": "...", "description": "..."}]}],
  "businessRisks": [{"title": "...", "description": "...", "severity": "medium", "mitigation": "..."}],
  "assumption": {"title": "...", "description": "..."} // or null if none
}`;

      const res = await model.invoke([
        new SystemMessage(isEs ? "Responde únicamente en JSON válido." : "Respond only with valid JSON."),
        new HumanMessage(prompt),
      ]);

      const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      const parsed = extractJson(text);
      epics = Array.isArray(parsed.epics) ? parsed.epics : [];
      businessRisks = Array.isArray(parsed.businessRisks) ? parsed.businessRisks : [];
      if (iteration === 1) {
        newAssumption = parsed.assumption || {
          title: isEs ? "Asumir Infraestructura Cloud Híbrida" : "Assume Cloud & Security Tier",
          description: isEs
            ? "¿Aceptas asumir despliegue en nube con autenticación OIDC y cifrado en tránsito?"
            : "Do you approve assuming cloud deployment with OIDC authentication and transit encryption?",
        };
      }
    } catch (err) {
      console.warn("LLM manager parsing error, falling back to deterministic:", err);
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

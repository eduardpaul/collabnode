import { useState, useEffect, useRef } from "react";
import { useCollabJoin } from "@collabnode/react";
import { edgesOfType } from "@collabnode/runtime";
import type { SolutionPlanner } from "./workspace.types.ts";
import type { CollabGraph } from "@collabnode/graph-view";
import type { CollabMermaid } from "./mermaid/element.ts";
import { markDirtyAndCascade, markParentDirtyOnDelete } from "./agent/dirty.ts";
import {
  formatTaskDescription,
  nextPoints,
  parsePoints,
} from "./agent/schemas.ts";

interface AgentLog {
  actor: "manager" | "architect" | "user" | "system";
  text: string;
  at: string;
}

interface PlannerStatusResponse {
  status: "idle" | "planning" | "waiting_user_validation" | "approved";
  managerAgrees: boolean;
  architectAgrees: boolean;
  iteration: number;
  activeAssumptionId?: string;
  logs: AgentLog[];
}

interface WorkspaceItem {
  id: string;
  appName: string;
  language: "en" | "es";
  status: string;
  iteration: number;
  managerAgrees: boolean;
  architectAgrees: boolean;
}

export function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const initialWorkspace = urlParams.get("w") || "solution-planner-1";

  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string>(initialWorkspace);
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [isCreatingWs, setIsCreatingWs] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsId, setNewWsId] = useState("");

  const [lang, setLang] = useState<"en" | "es">("en");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agentLogs, setAgentLogs] = useState<AgentLog[]>([]);
  const [validationComment, setValidationComment] = useState("");
  const [reviseMessage, setReviseMessage] = useState("");
  const [editingC4Id, setEditingC4Id] = useState<string | null>(null);
  const [c4DraftMarkdown, setC4DraftMarkdown] = useState<string>("");

  const graphRef = useRef<CollabGraph | null>(null);
  const c4MermaidRef = useRef<CollabMermaid | null>(null);
  const allMermaidRef = useRef<CollabMermaid | null>(null);

  // Fetch workspaces list
  const fetchWorkspaces = async () => {
    try {
      const res = await fetch("/api/workspaces");
      const list = await res.json();
      if (Array.isArray(list)) {
        setWorkspaces(list);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchWorkspaces();
    const interval = setInterval(fetchWorkspaces, 2000);
    return () => clearInterval(interval);
  }, []);

  // The server owns the document id, the schema, and the relay coordinates;
  // `useCollabJoin` asks for them and connects to what comes back.
  const { session, snapshot, nodesByType, isConnected, isLoading, upsertNode, deleteNode, upsertEdge, deleteEdge } =
    useCollabJoin<SolutionPlanner>(
      `/api/collab/join?workspace=${encodeURIComponent(currentWorkspaceId)}&lang=${lang}`,
      { actorId: "human-user" },
    );

  // Bind session to graph web components
  useEffect(() => {
    if (!session) return;
    // The graph and mermaid web components render any workspace, so they take
    // the untyped session.
    const untyped = session.as();
    if (graphRef.current) graphRef.current.session = untyped;
    if (c4MermaidRef.current) c4MermaidRef.current.session = untyped;
    if (allMermaidRef.current) allMermaidRef.current.session = untyped;
  }, [session]);

  // Extract domain nodes from the live collaborative graph
  const nodes = snapshot?.nodes ?? [];
  const edges = snapshot?.edges ?? [];
  // The one edge type this board reads by name. Going through `edgesOfType`
  // means the name is checked against the schema instead of being a string that
  // quietly matches nothing when it is wrong.
  const taskEdges = snapshot ? edgesOfType(snapshot, "HAS_TASK") : [];
  const solutionState = nodesByType.SolutionState?.[0];
  const epics = nodesByType.Epic ?? [];
  const features = nodesByType.Feature ?? [];
  const c4Nodes = nodesByType.C4DiagramElement ?? [];
  const tasks = nodesByType.Task ?? [];
  const risks = nodesByType.Risk ?? [];
  const assumptions = nodesByType.Assumption ?? [];

  // Structure comes off the edges, never off a title copied into a child. A
  // renamed Epic keeps its Features; a Feature that was never linked shows up
  // as unassigned instead of silently vanishing from the board.
  const childrenByParent = (edgeType: string) => {
    const map = new Map<string, string[]>();
    for (const edge of edges) {
      if (edge.type !== edgeType) continue;
      const list = map.get(edge.from) ?? [];
      list.push(edge.to);
      map.set(edge.from, list);
    }
    return map;
  };
  const featureIdsByEpic = childrenByParent("HAS_FEATURE");
  const taskIdsByFeature = childrenByParent("HAS_TASK");
  const featuresById = new Map(features.map((f) => [f.id, f]));
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const linkedFeatureIds = new Set([...featureIdsByEpic.values()].flat());
  const linkedTaskIds = new Set([...taskIdsByFeature.values()].flat());
  const orphanFeatures = features.filter((f) => !linkedFeatureIds.has(f.id));
  const orphanTasks = tasks.filter((t) => !linkedTaskIds.has(t.id));
  const featuresOfEpic = (epicId: string) =>
    (featureIdsByEpic.get(epicId) ?? [])
      .map((id) => featuresById.get(id))
      .filter((f): f is NonNullable<typeof f> => f !== undefined);
  const tasksOfFeature = (featureId: string) =>
    (taskIdsByFeature.get(featureId) ?? [])
      .map((id) => tasksById.get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);

  const currentStatus = String(solutionState?.properties.status ?? "idle");
  const managerAgrees = Boolean(solutionState?.properties.managerAgrees);
  const architectAgrees = Boolean(solutionState?.properties.architectAgrees);
  const iteration = Number(solutionState?.properties.iteration ?? 0);
  const dirtyCount = nodes.filter((n) => n.type !== "SolutionState" && n.properties.dirty === true).length;
  const canReviseDirty =
    dirtyCount > 0 && currentStatus !== "planning" && currentStatus !== "waiting_user_validation";
  const pendingAssumptionId = solutionState?.properties.pendingAssumptionId as string | undefined;
  // Written by the agent that is mid-run, cleared when its step ends — this is
  // the only thing on the board that moves *while* an agent is thinking.
  const activeAgent = String(solutionState?.properties.activeAgent ?? "none");

  // Only an assumption that is *still pending* gets the banner, and only while
  // the workflow is actually paused on it. Matching on the id alone kept the
  // banner up after the user had already approved or rejected it, and the
  // fallback matched any other pending assumption regardless of which one
  // SolutionState points at — including once the pause had been lifted.
  const pendingAssumption =
    currentStatus === "waiting_user_validation"
      ? (assumptions.find(
          (a) => a.id === pendingAssumptionId && a.properties.status === "pending",
        ) ?? assumptions.find((a) => a.properties.status === "pending"))
      : undefined;

  // Poll agent state and logs for the active workspace
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/planner/status?workspace=${encodeURIComponent(currentWorkspaceId)}`);
        const data: PlannerStatusResponse = await res.json();
        if (data.logs && data.logs.length > 0) {
          setAgentLogs(data.logs);
        } else {
          setAgentLogs([]);
        }
      } catch {
        // ignore
      }
    };

    fetchStatus();
    const timer = setInterval(fetchStatus, 1500);
    return () => clearInterval(timer);
  }, [currentWorkspaceId]);

  const isEs = lang === "es";

  // --- Workspace Switcher Handlers ---
  const handleSelectWorkspace = (wsId: string) => {
    setCurrentWorkspaceId(wsId);
    window.history.pushState({}, "", `?w=${encodeURIComponent(wsId)}`);
  };

  const handleCreateWorkspace = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const appName = newWsName.trim();
    if (!appName) return;

    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appName,
          id: newWsId.trim() || undefined,
          language: lang,
        }),
      });
      const created = await res.json();
      setIsCreatingWs(false);
      setNewWsName("");
      setNewWsId("");
      await fetchWorkspaces();
      handleSelectWorkspace(created.id);
    } catch (err) {
      console.error("Create workspace error:", err);
    }
  };

  const handleDeleteWorkspace = async (wsId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(isEs ? `¿Eliminar espacio "${wsId}"?` : `Delete workspace "${wsId}"?`)) return;
    try {
      await fetch(`/api/workspaces/${encodeURIComponent(wsId)}`, { method: "DELETE" });
      await fetchWorkspaces();
      if (currentWorkspaceId === wsId) {
        handleSelectWorkspace("solution-planner-1");
      }
    } catch (err) {
      console.error("Delete workspace error:", err);
    }
  };

  // --- Agent & Workflow Execution Handlers ---
  const handleStartPlanning = async (customPrompt?: string) => {
    const textToUse = customPrompt || description;
    if (!textToUse.trim()) return;
    setIsSubmitting(true);

    try {
      await fetch("/api/planner/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: currentWorkspaceId,
          description: textToUse,
          language: lang,
        }),
      });
    } catch (err) {
      console.error("Start planning error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const markHumanDirty = async (nodeId: string | undefined) => {
    if (!session || !nodeId) return;
    await markDirtyAndCascade(session, nodeId);
  };

  const markParentBeforeDelete = async (nodeId: string) => {
    if (!session) return;
    await markParentDirtyOnDelete(session, nodeId);
  };

  const handleReviseDirty = async () => {
    if (!canReviseDirty) return;
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/planner/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: currentWorkspaceId,
          reviewMessage: reviseMessage.trim() || undefined,
        }),
      });
      if (res.ok) {
        setReviseMessage("");
      }
    } catch (err) {
      console.error("Revise dirty error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTriggerAgent = async (actor: "manager" | "architect") => {
    setIsSubmitting(true);
    try {
      await fetch("/api/planner/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: currentWorkspaceId,
          actor,
        }),
      });
    } catch (err) {
      console.error("Trigger agent error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleValidation = async (assumptionId: string, approved: boolean, comment?: string) => {
    setIsSubmitting(true);
    try {
      await fetch("/api/planner/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: currentWorkspaceId,
          assumptionId,
          approved,
          comment: comment || validationComment || undefined,
        }),
      });
      setValidationComment("");
    } catch (err) {
      console.error("Validation error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm(isEs ? "¿Deseas reiniciar este espacio de trabajo?" : "Reset this workspace to initial state?")) {
      return;
    }
    setIsSubmitting(true);
    try {
      await fetch("/api/planner/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: currentWorkspaceId }),
      });
      setAgentLogs([]);
      setDescription("");
      setReviseMessage("");
    } catch (err) {
      console.error("Reset error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- Human CRUD Actions on Epics ---
  const handleAddEpic = async () => {
    const title = window.prompt(isEs ? "Título del nuevo Epic:" : "Title of new Epic:")?.trim();
    if (!title) return;
    const desc = window.prompt(isEs ? "Descripción del Epic:" : "Description of Epic:", "")?.trim() ?? "";
    const priority = (window.prompt(isEs ? "Prioridad (low/medium/high):" : "Priority (low/medium/high):", "medium")?.trim().toLowerCase() || "medium") as "low" | "medium" | "high";

    const id = await upsertNode(
      { type: "Epic", properties: { title, description: desc, priority, dirty: true } },
      { actorId: "human-user" },
    );
    await markHumanDirty(id);
  };

  const handleEditEpic = async (epicId: string) => {
    const epic = epics.find((e) => e.id === epicId);
    if (!epic) return;
    const title = window.prompt(isEs ? "Editar título:" : "Edit Title:", String(epic.properties.title))?.trim();
    if (!title) return;
    const desc = window.prompt(isEs ? "Editar descripción:" : "Edit Description:", String(epic.properties.description ?? ""))?.trim() ?? "";
    const priority = (window.prompt(isEs ? "Prioridad (low/medium/high):" : "Priority (low/medium/high):", String(epic.properties.priority ?? "medium"))?.trim().toLowerCase() || "medium") as "low" | "medium" | "high";

    await upsertNode(
      { id: epicId, type: "Epic", properties: { ...epic.properties, title, description: desc, priority, dirty: true } },
      { actorId: "human-user" },
    );
    await markHumanDirty(epicId);
  };

  const handleDeleteEpic = async (epicId: string) => {
    if (!window.confirm(isEs ? "¿Eliminar este Epic y sus enlaces?" : "Delete this Epic and associated links?")) return;
    await markParentBeforeDelete(epicId);
    const connectedEdges = edges.filter((e) => e.from === epicId || e.to === epicId);
    for (const edge of connectedEdges) {
      await deleteEdge(edge.id, { actorId: "human-user" });
    }
    await deleteNode(epicId, { actorId: "human-user" });
  };

  // --- Human CRUD Actions on Features ---
  const handleAddFeature = async (epicId: string) => {
    const epic = epics.find((e) => e.id === epicId);
    const epicTitle = String(epic?.properties.title ?? "");
    const title = window.prompt(isEs ? `Nueva Feature para "${epicTitle}":` : `New Feature for "${epicTitle}":`)?.trim();
    if (!title) return;
    const desc = window.prompt(isEs ? "Descripción de la Feature:" : "Feature Description:", "")?.trim() ?? "";

    const featId = await upsertNode(
      { type: "Feature", properties: { title, description: desc, dirty: true } },
      { actorId: "human-user" },
    );

    // The edge is what puts the Feature under the Epic. Nothing about the Epic
    // is copied into the Feature's properties.
    await upsertEdge(
      { type: "HAS_FEATURE", from: epicId, to: featId },
      { actorId: "human-user" },
    );
    await markHumanDirty(featId);
  };

  const handleEditFeature = async (featId: string) => {
    const feat = features.find((f) => f.id === featId);
    if (!feat) return;
    const title = window.prompt(isEs ? "Editar título de Feature:" : "Edit Feature Title:", String(feat.properties.title))?.trim();
    if (!title) return;
    const desc = window.prompt(isEs ? "Editar descripción:" : "Edit Description:", String(feat.properties.description ?? ""))?.trim() ?? "";

    await upsertNode(
      { id: featId, type: "Feature", properties: { ...feat.properties, title, description: desc, dirty: true } },
      { actorId: "human-user" },
    );
    await markHumanDirty(featId);
  };

  const handleDeleteFeature = async (featId: string) => {
    if (!window.confirm(isEs ? "¿Eliminar esta Feature?" : "Delete this Feature?")) return;
    await markParentBeforeDelete(featId);
    const connectedEdges = edges.filter((e) => e.from === featId || e.to === featId);
    for (const edge of connectedEdges) {
      await deleteEdge(edge.id, { actorId: "human-user" });
    }
    await deleteNode(featId, { actorId: "human-user" });
  };

  // --- Human CRUD Actions on Tasks (story points + 4 axes) ---
  const handleAddTask = async (featureId?: string) => {
    const feature = featureId ? featuresById.get(featureId) : undefined;
    const title = window.prompt(
      feature
        ? isEs
          ? `Nueva Tarea para "${String(feature.properties.title)}":`
          : `New Task for "${String(feature.properties.title)}":`
        : isEs
          ? "Título de la nueva Tarea:"
          : "Title of new Task:",
    )?.trim();
    if (!title) return;
    const what = window.prompt(
      isEs ? "Qué (resultado funcional / flujo de usuario):" : "What (functional outcome / user journey):",
      "",
    )?.trim();
    if (!what) return;
    const how = window.prompt(
      isEs ? "Cómo (enfoque técnico / infraestructura):" : "How (technical approach / infrastructure):",
      "",
    )?.trim();
    if (!how) return;
    const functionalPoints = parsePoints(
      window.prompt(isEs ? "Puntos funcionales (1-21):" : "Functional points (1-21):", "3"),
      3,
    );
    const technicalPoints = parsePoints(
      window.prompt(isEs ? "Puntos técnicos (1-21):" : "Technical points (1-21):", "3"),
      3,
    );
    const complexity = Number(window.prompt(isEs ? "Complejidad (0 a 5):" : "Complexity (0 to 5):", "2") ?? 2);
    const uncertainty = Number(window.prompt(isEs ? "Incertidumbre (0 a 5):" : "Uncertainty (0 to 5):", "1") ?? 1);
    const friction = Number(window.prompt(isEs ? "Fricción (0 a 5):" : "Friction (0 to 5):", "1") ?? 1);
    const nfrScale = Number(window.prompt(isEs ? "Escala NFR (0 a 3):" : "NFR Scale (0 to 3):", "1") ?? 1);

    const taskId = await upsertNode(
      {
        type: "Task",
        properties: {
          title,
          description: formatTaskDescription(what, how, isEs ? "es" : "en"),
          functionalPoints,
          technicalPoints,
          complexity,
          uncertainty,
          friction,
          nfrScale,
          dirty: true,
        },
      },
      { actorId: "human-user" },
    );
    if (featureId) {
      await upsertEdge(
        { type: "HAS_TASK", from: featureId, to: taskId },
        { actorId: "human-user" },
      );
    }
    await markHumanDirty(taskId);
  };

  /** Move a Task under a Feature — delete the old HAS_TASK edge, create the new one. */
  const handleLinkTask = async (taskId: string) => {
    if (features.length === 0) {
      window.alert(isEs ? "Crea primero una Feature." : "Create a Feature first.");
      return;
    }
    const menu = features
      .map((f, i) => `${i + 1}. ${String(f.properties.title)}`)
      .join("\n");
    const answer = window.prompt(
      isEs
        ? `¿Bajo qué Feature va esta tarea?\n${menu}`
        : `Which Feature does this task belong to?\n${menu}`,
      "1",
    );
    const choice = Number(answer);
    const target = features[choice - 1];
    if (!target) return;

    for (const edge of taskEdges.filter((e) => e.to === taskId)) {
      await deleteEdge(edge.id, { actorId: "human-user" });
    }
    await upsertEdge({ type: "HAS_TASK", from: target.id, to: taskId }, { actorId: "human-user" });
    await markHumanDirty(taskId);
  };

  const handleEditTaskDescription = async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const title = window.prompt(isEs ? "Editar título:" : "Edit Title:", String(task.properties.title))?.trim();
    if (!title) return;
    const desc = window.prompt(
      isEs
        ? "Editar descripción (debe incluir Qué y Cómo):"
        : "Edit Description (must include What and How):",
      String(task.properties.description ?? ""),
    )?.trim();
    if (desc === undefined) return;

    await upsertNode(
      { id: taskId, type: "Task", properties: { ...task.properties, title, description: desc, dirty: true } },
      { actorId: "human-user" },
    );
    await markHumanDirty(taskId);
  };

  const handleEditTaskAxis = async (
    taskId: string,
    axis: "complexity" | "uncertainty" | "friction" | "nfrScale" | "functionalPoints" | "technicalPoints",
  ) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const current = Number(task.properties[axis] ?? 0);
    const next =
      axis === "functionalPoints" || axis === "technicalPoints"
        ? nextPoints(current)
        : current + 1 > (axis === "nfrScale" ? 3 : 5)
          ? 0
          : current + 1;

    await upsertNode(
      { id: taskId, type: "Task", properties: { ...task.properties, [axis]: next, dirty: true } },
      { actorId: "human-user" },
    );
    await markHumanDirty(taskId);
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!window.confirm(isEs ? "¿Eliminar esta tarea?" : "Delete this task?")) return;
    await markParentBeforeDelete(taskId);
    const connectedEdges = edges.filter((e) => e.from === taskId || e.to === taskId);
    for (const edge of connectedEdges) {
      await deleteEdge(edge.id, { actorId: "human-user" });
    }
    await deleteNode(taskId, { actorId: "human-user" });
  };

  // --- Human CRUD Actions on Assumptions ---
  const handleAddAssumption = async () => {
    const title = window.prompt(isEs ? "Título de la nueva Suposición:" : "New Assumption Title:")?.trim();
    if (!title) return;
    const desc = window.prompt(isEs ? "Descripción detallada:" : "Detailed Description:", "")?.trim() ?? "";

    const assumptionId = await upsertNode(
      {
        type: "Assumption",
        properties: {
          title,
          description: desc,
          status: "pending",
          raisedBy: "human",
          dirty: true,
        },
      },
      { actorId: "human-user" },
    );
    await markHumanDirty(assumptionId);
  };

  const handleEditAssumption = async (assumptionId: string) => {
    const assump = assumptions.find((a) => a.id === assumptionId);
    if (!assump) return;
    const title = window.prompt(isEs ? "Editar título:" : "Edit Title:", String(assump.properties.title))?.trim();
    if (!title) return;
    const desc = window.prompt(isEs ? "Editar descripción:" : "Edit Description:", String(assump.properties.description ?? ""))?.trim() ?? "";

    await upsertNode(
      { id: assumptionId, type: "Assumption", properties: { ...assump.properties, title, description: desc, dirty: true } },
      { actorId: "human-user" },
    );
    await markHumanDirty(assumptionId);
  };

  const handleDeleteAssumption = async (assumptionId: string) => {
    if (!window.confirm(isEs ? "¿Eliminar esta suposición?" : "Delete this assumption?")) return;
    await markParentBeforeDelete(assumptionId);
    await deleteNode(assumptionId, { actorId: "human-user" });
  };

  // --- Human CRUD Actions on Risks ---
  const handleAddRisk = async () => {
    const title = window.prompt(isEs ? "Título del Riesgo:" : "Risk Title:")?.trim();
    if (!title) return;
    const desc = window.prompt(isEs ? "Descripción:" : "Description:", "")?.trim() ?? "";
    const severity = (window.prompt(isEs ? "Severidad (low/medium/high/critical):" : "Severity (low/medium/high/critical):", "medium")?.trim().toLowerCase() || "medium") as "low" | "medium" | "high" | "critical";
    const category = (window.prompt(isEs ? "Categoría (business/technical):" : "Category (business/technical):", "business")?.trim().toLowerCase() || "business") as "business" | "technical";
    const mitigation = window.prompt(isEs ? "Estrategia de Mitigación:" : "Mitigation Strategy:", "")?.trim() ?? "";

    const riskId = await upsertNode(
      {
        type: "Risk",
        properties: { title, description: desc, severity, category, mitigation, dirty: true },
      },
      { actorId: "human-user" },
    );
    await markHumanDirty(riskId);
  };

  const handleDeleteRisk = async (riskId: string) => {
    if (!window.confirm(isEs ? "¿Eliminar este riesgo?" : "Delete this risk?")) return;
    await markParentBeforeDelete(riskId);
    await deleteNode(riskId, { actorId: "human-user" });
  };

  // --- Human C4 Markdown Editing ---
  const handleSaveC4 = async (c4Id: string) => {
    const c4 = c4Nodes.find((c) => c.id === c4Id);
    if (!c4) return;
    await upsertNode(
      {
        id: c4Id,
        type: "C4DiagramElement",
        properties: {
          ...c4.properties,
          description: c4DraftMarkdown,
          dirty: true,
        },
      },
      { actorId: "human-user" },
    );
    await markHumanDirty(c4Id);
    setEditingC4Id(null);
  };

  const suggestions = isEs
    ? [
        "Editor colaborativo de documentos estilo Notion con sincronización offline",
        "Plataforma de streaming de video con chat en tiempo real y microservicios",
        "Sistema bancario móvil con autenticación biométrica y auditoría distribuida",
      ]
    : [
        "Collaborative Notion-style document editor with offline sync & AI summaries",
        "Video streaming platform with live chat and microservices architecture",
        "Mobile banking solution with biometric auth and distributed audit logging",
      ];

  const activeWsMeta = workspaces.find((w) => w.id === currentWorkspaceId);

  const renderTaskCard = (task: (typeof tasks)[number]) => {
    const taskDirty = task.properties.dirty === true;
    const feature = featuresById.get(
      taskEdges.find((e) => e.to === task.id)?.from ?? "",
    );

    return (
                  <div key={task.id} className={`card ${taskDirty ? "dirty" : ""}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <span className="card-title">
                        {String(task.properties.title)}
                        {taskDirty && (
                          <span className="badge badge-dirty" style={{ marginLeft: "8px" }}>
                            {isEs ? "Sin revisar" : "Dirty"}
                          </span>
                        )}
                      </span>

                      <div style={{ display: "flex", gap: "4px" }}>
                        <button
                          type="button"
                          className="btn-icon"
                          onClick={() => handleLinkTask(task.id)}
                          title={
                            feature
                              ? isEs
                                ? `Feature: ${String(feature.properties.title)} — clic para mover`
                                : `Feature: ${String(feature.properties.title)} — click to move`
                              : isEs
                                ? "Sin Feature — clic para enlazar"
                                : "No Feature — click to link"
                          }
                        >
                          {feature ? "🔗" : "⛓️‍💥"}
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          onClick={() => handleEditTaskDescription(task.id)}
                          title={isEs ? "Editar tarea" : "Edit Task"}
                        >
                          ✏️
                        </button>
                        <button type="button" className="btn-icon" onClick={() => handleDeleteTask(task.id)} title="Delete Task">
                          🗑️
                        </button>
                      </div>
                    </div>

                    <div
                      className="card-desc"
                      style={{ cursor: "pointer", whiteSpace: "pre-wrap" }}
                      onClick={() => handleEditTaskDescription(task.id)}
                      title={isEs ? "Haz clic para editar Qué y Cómo" : "Click to edit What and How"}
                    >
                      {String(task.properties.description)}
                    </div>

                    {/* Story points + 4-axis estimation */}
                    <div className="axes-grid">
                      <div
                        className="axis-item"
                        style={{ cursor: "pointer" }}
                        onClick={() => handleEditTaskAxis(task.id, "functionalPoints")}
                        title={isEs ? "Haz clic para subir un peldaño de la escala" : "Click to step up the estimate ladder"}
                      >
                        <span className="axis-label">{isEs ? "Funcional" : "Functional"}:</span>
                        <span className="axis-value">{String(task.properties.functionalPoints ?? 1)} pts ⟳</span>
                      </div>

                      <div
                        className="axis-item"
                        style={{ cursor: "pointer" }}
                        onClick={() => handleEditTaskAxis(task.id, "technicalPoints")}
                        title={isEs ? "Haz clic para subir un peldaño de la escala" : "Click to step up the estimate ladder"}
                      >
                        <span className="axis-label">{isEs ? "Técnico" : "Technical"}:</span>
                        <span className="axis-value">{String(task.properties.technicalPoints ?? 1)} pts ⟳</span>
                      </div>

                      <div
                        className="axis-item"
                        style={{ cursor: "pointer" }}
                        onClick={() => handleEditTaskAxis(task.id, "complexity")}
                        title={isEs ? "Haz clic para ajustar (0-5)" : "Click to adjust (0-5)"}
                      >
                        <span className="axis-label">{isEs ? "Complejidad" : "Complexity"}:</span>
                        <span className="axis-value">{String(task.properties.complexity ?? 0)}/5 ⟳</span>
                      </div>

                      <div
                        className="axis-item"
                        style={{ cursor: "pointer" }}
                        onClick={() => handleEditTaskAxis(task.id, "uncertainty")}
                        title={isEs ? "Haz clic para ajustar (0-5)" : "Click to adjust (0-5)"}
                      >
                        <span className="axis-label">{isEs ? "Incertidumbre" : "Uncertainty"}:</span>
                        <span className="axis-value">{String(task.properties.uncertainty ?? 0)}/5 ⟳</span>
                      </div>

                      <div
                        className="axis-item"
                        style={{ cursor: "pointer" }}
                        onClick={() => handleEditTaskAxis(task.id, "friction")}
                        title={isEs ? "Haz clic para ajustar (0-5)" : "Click to adjust (0-5)"}
                      >
                        <span className="axis-label">{isEs ? "Fricción" : "Friction"}:</span>
                        <span className="axis-value">{String(task.properties.friction ?? 0)}/5 ⟳</span>
                      </div>

                      <div
                        className="axis-item"
                        style={{ cursor: "pointer" }}
                        onClick={() => handleEditTaskAxis(task.id, "nfrScale")}
                        title={isEs ? "Haz clic para ajustar (0-3)" : "Click to adjust (0-3)"}
                      >
                        <span className="axis-label">NFR Scale:</span>
                        <span className="axis-value">{String(task.properties.nfrScale ?? 0)}/3 ⟳</span>
                      </div>
                    </div>
                  </div>
    );
  };

  return (
    <div className="app-container">
      {/* Top Header */}
      <header className="header">
        <div className="header-left">
          <h1>
            <span>🚀</span>
            {isEs ? "Planificador de Soluciones Multiespacio" : "Solution Planner — Collabnode"}
          </h1>
          <p>
            {isEs
              ? `Espacio activo: "${activeWsMeta?.appName || currentWorkspaceId}" — Human + AI Manager + AI Architect`
              : `Active workspace: "${activeWsMeta?.appName || currentWorkspaceId}" — Human + AI Manager + AI Architect`}
          </p>
        </div>
        <div className="header-right">
          <button
            type="button"
            className="lang-toggle"
            onClick={() => setLang(lang === "en" ? "es" : "en")}
          >
            {isEs ? "🇪🇸 Español" : "🇺🇸 English"}
          </button>
          <button
            type="button"
            className="btn-action"
            style={{ background: "#334155", color: "#f8fafc" }}
            onClick={handleReset}
            title={isEs ? "Reiniciar espacio activo" : "Reset Active Workspace"}
          >
            🔄 {isEs ? "Reiniciar Espacio" : "Reset Workspace"}
          </button>
          <div className={`conn-pill ${isConnected ? "connected" : "disconnected"}`}>
            {isLoading
              ? isEs
                ? "Conectando..."
                : "Connecting..."
              : isConnected
              ? isEs
                ? "● En Línea"
                : "● Live CRDT"
              : isEs
              ? "Desconectado"
              : "Disconnected"}
          </div>
        </div>
      </header>

      {/* 1..N Workspaces Switcher Toolbar */}
      <div className="workspaces-bar">
        <div className="workspaces-tabs">
          <span className="workspaces-label">
            📁 {isEs ? "Espacios de Solución (1..N):" : "Solution Workspaces (1..N):"}
          </span>
          {workspaces.map((ws) => {
            const isActive = ws.id === currentWorkspaceId;
            return (
              <div
                key={ws.id}
                className={`workspace-tab ${isActive ? "active" : ""}`}
                onClick={() => handleSelectWorkspace(ws.id)}
              >
                <span className="ws-name">{ws.appName || ws.id}</span>
                {ws.status && ws.status !== "idle" && (
                  <span
                    className={`ws-badge ${
                      ws.status === "approved"
                        ? "approved"
                        : ws.status === "waiting_user_validation"
                        ? "waiting"
                        : "planning"
                    }`}
                  >
                    {ws.status === "approved" ? "✓" : ws.status === "waiting_user_validation" ? "⚠️" : "⚡"}
                  </span>
                )}
                {ws.id !== "solution-planner-1" && (
                  <button
                    type="button"
                    className="ws-delete-btn"
                    onClick={(e) => handleDeleteWorkspace(ws.id, e)}
                    title={isEs ? "Cerrar espacio" : "Close workspace"}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="btn-add-ws"
            onClick={() => setIsCreatingWs(!isCreatingWs)}
          >
            + {isEs ? "Nueva Solución" : "New Solution"}
          </button>
        </div>

        {isCreatingWs && (
          <form className="new-ws-form" onSubmit={handleCreateWorkspace}>
            <input
              type="text"
              className="prompt-input"
              placeholder={
                isEs
                  ? "Nombre de la nueva solución (ej. FinTech Mobile Banking)..."
                  : "Solution Name (e.g. FinTech Mobile Banking)..."
              }
              value={newWsName}
              onChange={(e) => setNewWsName(e.target.value)}
              autoFocus
            />
            <input
              type="text"
              className="prompt-input"
              style={{ maxWidth: "200px" }}
              placeholder={isEs ? "ID opcional (slug)..." : "Optional slug ID..."}
              value={newWsId}
              onChange={(e) => setNewWsId(e.target.value)}
            />
            <button type="submit" className="btn-primary" disabled={!newWsName.trim()}>
              {isEs ? "Crear y Abrir" : "Create & Open"}
            </button>
            <button type="button" className="btn-action" onClick={() => setIsCreatingWs(false)}>
              {isEs ? "Cancelar" : "Cancel"}
            </button>
          </form>
        )}
      </div>

      {/* Input & Control Section */}
      <section className="prompt-section">
        <div className="prompt-row">
          <input
            type="text"
            className="prompt-input"
            placeholder={
              isEs
                ? "Describe la aplicación que deseas planificar en este espacio..."
                : "Describe the application you want to plan in this workspace..."
            }
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleStartPlanning()}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={isSubmitting || !description.trim()}
            onClick={() => handleStartPlanning()}
          >
            {isSubmitting
              ? isEs
                ? "Planificando..."
                : "Planning..."
              : isEs
              ? "🚀 Co-Diseñar Solución"
              : "🚀 Start Co-Design"}
          </button>
        </div>

        {/* Manual Agent Trigger Buttons */}
        <div
          style={{
            display: "flex",
            gap: "10px",
            flexWrap: "wrap",
            alignItems: "center",
            paddingTop: "6px",
          }}
        >
          <span style={{ fontSize: "13px", color: "var(--text-muted)", fontWeight: 600 }}>
            {isEs ? "Disparar Agente Directamente:" : "Invoke Agents Directly:"}
          </span>
          <button
            type="button"
            className="btn-action"
            disabled={isSubmitting}
            onClick={() => handleTriggerAgent("manager")}
          >
            👔 {isEs ? "Ejecutar Gestor IA (Epics & Negocio)" : "Run AI Manager (Epics & Scope)"}
          </button>
          <button
            type="button"
            className="btn-action"
            disabled={isSubmitting}
            onClick={() => handleTriggerAgent("architect")}
          >
            📐 {isEs ? "Ejecutar Arquitecto IA (C4 & Tareas)" : "Run AI Architect (C4 & Tasks)"}
          </button>
        </div>

        <div className="revise-row">
          <input
            type="text"
            className="prompt-input"
            data-testid="revise-message"
            placeholder={
              isEs
                ? "Nota para el equipo (opcional): qué deben considerar al revisar los nodos sucios..."
                : "Note for the crew (optional): what they should consider when revising dirty nodes..."
            }
            value={reviseMessage}
            onChange={(e) => setReviseMessage(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleReviseDirty()}
            disabled={isSubmitting || dirtyCount === 0}
          />
          <button
            type="button"
            className="btn-action"
            data-testid="revise-dirty"
            disabled={isSubmitting || !canReviseDirty}
            onClick={() => void handleReviseDirty()}
            title={
              dirtyCount === 0
                ? isEs
                  ? "No hay nodos sucios"
                  : "No dirty nodes"
                : isEs
                  ? "Revisar nodos sucios con Gestor ↔ Arquitecto"
                  : "Revise dirty nodes with Manager ↔ Architect"
            }
          >
            ♻️{" "}
            {isEs
              ? `Revisar nodos sucios${dirtyCount > 0 ? ` (${dirtyCount})` : ""}`
              : `Revise dirty nodes${dirtyCount > 0 ? ` (${dirtyCount})` : ""}`}
          </button>
        </div>

        <div className="suggestions">
          <span>{isEs ? "Sugerencias:" : "Try:"}</span>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="suggestion-chip"
              onClick={() => {
                setDescription(s);
                void handleStartPlanning(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </section>

      {/* Status & Consensus Bar */}
      <div className="status-bar">
        <div className="status-badges">
          <span className="badge badge-status">
            🔄 {isEs ? `Iteración ${iteration}` : `Iteration ${iteration}`}
          </span>
          <span
            className={`badge ${
              currentStatus === "approved"
                ? "badge-approved"
                : currentStatus === "waiting_user_validation"
                ? "badge-waiting"
                : "badge-status"
            }`}
          >
            {currentStatus === "approved" && (isEs ? "✅ Consenso Aprobado" : "✅ Consensus Approved")}
            {currentStatus === "waiting_user_validation" &&
              (isEs ? "⚠️ Esperando Validación Humana" : "⚠️ Waiting for Human Validation")}
            {currentStatus === "planning" && (isEs ? "⚡ Agentes Planificando..." : "⚡ Agents Planning...")}
            {currentStatus === "idle" && (isEs ? "💤 En Espera" : "💤 Idle")}
          </span>
          <span
            className={`badge badge-agent ${
              activeAgent === "manager" ? "working" : managerAgrees ? "agreed" : ""
            }`}
          >
            👔 {isEs ? "Gestor:" : "Manager:"}{" "}
            {activeAgent === "manager"
              ? isEs
                ? "Trabajando…"
                : "Working…"
              : managerAgrees
              ? isEs
                ? "Aprueba ✓"
                : "Agreed ✓"
              : isEs
              ? "Revisando..."
              : "Reviewing..."}
          </span>
          <span
            className={`badge badge-agent ${
              activeAgent === "architect" ? "working" : architectAgrees ? "agreed" : ""
            }`}
          >
            📐 {isEs ? "Arquitecto:" : "Architect:"}{" "}
            {activeAgent === "architect"
              ? isEs
                ? "Trabajando…"
                : "Working…"
              : architectAgrees
              ? isEs
                ? "Aprueba ✓"
                : "Agreed ✓"
              : isEs
              ? "Revisando..."
              : "Reviewing..."}
          </span>
          {dirtyCount > 0 && (
            <span className="badge badge-dirty">
              ✏️ {isEs ? `${dirtyCount} sin revisar` : `${dirtyCount} dirty — not revised`}
            </span>
          )}
        </div>
      </div>

      {/* Human-In-The-Loop Validation Banner (When an assumption is pending) */}
      {pendingAssumption && (
        <section className="validation-banner">
          <div className="validation-header">
            <span>⚠️</span>
            <span>
              {isEs
                ? "Suposición Pendiente de Validación Humana (Human-in-the-Loop)"
                : "Pending Human Validation (Human-in-the-Loop)"}
            </span>
          </div>
          <div className="validation-body">
            <strong style={{ fontSize: "15px", color: "#fff" }}>
              {String(pendingAssumption.properties.title)}
            </strong>
            <p style={{ marginTop: "4px" }}>{String(pendingAssumption.properties.description)}</p>
          </div>
          <div className="validation-actions">
            <input
              type="text"
              className="prompt-input"
              style={{ maxWidth: "400px" }}
              placeholder={isEs ? "Comentario opcional del usuario..." : "Optional user feedback/comment..."}
              value={validationComment}
              onChange={(e) => setValidationComment(e.target.value)}
            />
            <button
              type="button"
              className="btn-approve"
              disabled={isSubmitting}
              onClick={() => handleValidation(pendingAssumption.id, true)}
            >
              {isEs ? "✓ Aprobar Suposición y Continuar" : "✓ Approve Assumption & Run Architect"}
            </button>
            <button
              type="button"
              className="btn-reject"
              disabled={isSubmitting}
              onClick={() => handleValidation(pendingAssumption.id, false)}
            >
              {isEs ? "✗ Rechazar Suposición" : "✗ Reject Assumption"}
            </button>
          </div>
        </section>
      )}

      {/* Main 3-Column Content View with Full Editing Capabilities */}
      <div className="grid-columns">
        {/* Column 1: Business Domain (Manager & Human Co-Design) */}
        <div className="column">
          <div className="column-head">
            <h2>
              <span>👔</span> {isEs ? "Gestión de Negocio (Epics & Features)" : "Business Scope (Epics & Features)"}
            </h2>
            <div style={{ display: "flex", gap: "6px" }}>
              <button type="button" className="btn-small" onClick={handleAddEpic}>
                + {isEs ? "Nuevo Epic" : "Add Epic"}
              </button>
              <span className="badge badge-agent">{epics.length} Epics</span>
            </div>
          </div>

          <div className="item-list">
            {epics.map((epic) => {
              const epicFeats = featuresOfEpic(epic.id);
              const epicDirty = epic.properties.dirty === true;
              return (
                <div key={epic.id} className={`card ${epicDirty ? "dirty" : ""}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div className="card-title">
                      {String(epic.properties.title)}
                      {epicDirty && (
                        <span className="badge badge-dirty" style={{ marginLeft: "8px" }}>
                          {isEs ? "Sin revisar" : "Dirty"}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: "4px" }}>
                      <button type="button" className="btn-icon" onClick={() => handleEditEpic(epic.id)} title="Edit Epic">
                        ✏️
                      </button>
                      <button type="button" className="btn-icon" onClick={() => handleDeleteEpic(epic.id)} title="Delete Epic">
                        🗑️
                      </button>
                    </div>
                  </div>

                  <div className="card-desc">{String(epic.properties.description)}</div>

                  <div className="card-meta">
                    <span className="badge badge-status">Prioridad: {String(epic.properties.priority)}</span>
                    <span className="badge badge-agent">{epicFeats.length} Features</span>
                    <button
                      type="button"
                      className="btn-small"
                      style={{ marginLeft: "auto", fontSize: "11px", padding: "2px 6px" }}
                      onClick={() => handleAddFeature(epic.id)}
                    >
                      + {isEs ? "Feature" : "Feature"}
                    </button>
                  </div>

                  {epicFeats.length > 0 && (
                    <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
                      {epicFeats.map((feat) => (
                        <div
                          key={feat.id}
                          style={{
                            background: "rgba(6, 182, 212, 0.08)",
                            borderLeft: `3px solid ${feat.properties.dirty === true ? "var(--warning)" : "#06b6d4"}`,
                            padding: "6px 8px",
                            borderRadius: "4px",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600, fontSize: "13px" }}>
                              {String(feat.properties.title)}
                              {feat.properties.dirty === true && (
                                <span className="badge badge-dirty" style={{ marginLeft: "6px" }}>
                                  {isEs ? "Sin revisar" : "Dirty"}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                              {String(feat.properties.description)}
                            </div>
                            <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
                              {tasksOfFeature(feat.id).length}{" "}
                              {isEs ? "tarea(s) enlazada(s)" : "linked task(s)"}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: "4px" }}>
                            <button type="button" className="btn-icon" onClick={() => handleEditFeature(feat.id)}>
                              ✏️
                            </button>
                            <button type="button" className="btn-icon" onClick={() => handleDeleteFeature(feat.id)}>
                              🗑️
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {epics.length === 0 && (
              <p className="card-desc">
                {isEs
                  ? "Aún no hay épicas creadas. Haz clic en '+ Nuevo Epic' o ejecuta el co-diseño arriba."
                  : "No epics yet. Click '+ Add Epic' or run the prompt above."}
              </p>
            )}

            {/* A Feature with no HAS_FEATURE edge belongs to no Epic. It would
                be invisible in an Epic-rooted list, so it gets its own bucket
                rather than disappearing from the plan. */}
            {orphanFeatures.length > 0 && (
              <div className="card dirty">
                <div className="card-title">
                  ⚠️ {isEs ? "Features sin Epic" : "Features with no Epic"}
                </div>
                <div className="card-desc">
                  {isEs
                    ? "Enlázalas a un Epic para que entren en el plan."
                    : "Link them to an Epic so they count as part of the plan."}
                </div>
                {orphanFeatures.map((feat) => (
                  <div key={feat.id} className="card-meta">
                    <span>{String(feat.properties.title)}</span>
                    <button
                      type="button"
                      className="btn-icon"
                      style={{ marginLeft: "auto" }}
                      onClick={() => handleEditFeature(feat.id)}
                    >
                      ✏️
                    </button>
                    <button type="button" className="btn-icon" onClick={() => handleDeleteFeature(feat.id)}>
                      🗑️
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Column 2: Architecture & Tasks (Architect & Human Co-Design) */}
        <div className="column">
          <div className="column-head">
            <h2>
              <span>📐</span> {isEs ? "Arquitectura C4 y Tareas" : "C4 & Tasks (Architect)"}
            </h2>
            <div style={{ display: "flex", gap: "6px" }}>
              <button type="button" className="btn-small" onClick={() => handleAddTask()}>
                + {isEs ? "Nueva Tarea" : "Add Task"}
              </button>
              <span className="badge badge-agent">{tasks.length} Tasks</span>
            </div>
          </div>

          <div className="mermaid-container" title={isEs ? "Diagrama C4 (un nodo por contenedor)" : "C4 diagram (one node per container)"}>
            <collab-mermaid
              ref={c4MermaidRef}
              visible-types="C4DiagramElement"
              kind="c4"
              theme="dark"
            />
          </div>

          {/* C4 elements: Person, System, Boundary, Container, Component */}
          {[...c4Nodes]
            .sort((a, b) => {
              const order: Record<string, number> = {
                Person: 0,
                System: 1,
                Boundary: 2,
                Container: 3,
                Component: 4,
              };
              return (order[String(a.properties.type)] ?? 9) - (order[String(b.properties.type)] ?? 9);
            })
            .map((c4) => {
            const isEditingThis = editingC4Id === c4.id;
            const c4Dirty = c4.properties.dirty === true;
            return (
              <div key={c4.id} className={`card ${c4Dirty ? "dirty" : ""}`}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div className="card-title">
                    🏛️ {String(c4.properties.title)} ({String(c4.properties.type ?? "C4")}
                    {c4.properties.external === true ? "_Ext" : ""})
                    {c4Dirty && (
                      <span className="badge badge-dirty" style={{ marginLeft: "8px" }}>
                        {isEs ? "Sin revisar" : "Dirty"}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn-small"
                    onClick={() => {
                      if (isEditingThis) {
                        void handleSaveC4(c4.id);
                      } else {
                        setC4DraftMarkdown(String(c4.properties.description ?? ""));
                        setEditingC4Id(c4.id);
                      }
                    }}
                  >
                    {isEditingThis ? (isEs ? "💾 Guardar" : "💾 Save") : (isEs ? "✏️ Editar C4" : "✏️ Edit C4")}
                  </button>
                </div>

                {isEditingThis ? (
                  <textarea
                    rows={8}
                    style={{
                      width: "100%",
                      background: "#090d16",
                      color: "#a5b4fc",
                      border: "1px solid var(--border)",
                      borderRadius: "4px",
                      padding: "8px",
                      fontFamily: "monospace",
                      fontSize: "12px",
                    }}
                    value={c4DraftMarkdown}
                    onChange={(e) => setC4DraftMarkdown(e.target.value)}
                  />
                ) : (
                  <pre
                    style={{
                      background: "#090d16",
                      padding: "8px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      overflowX: "auto",
                      color: "#a5b4fc",
                    }}
                  >
                    {String(c4.properties.description ?? "")}
                  </pre>
                )}
              </div>
            );
          })}

          {/* Tasks, grouped under the Feature each one implements. The grouping
              is the HAS_TASK edge — a task is never told which feature it
              belongs to through a property. */}
          <div className="item-list">
            {features.map((feature) => {
              const featureTasks = tasksOfFeature(feature.id);
              return (
                <div key={feature.id} className="task-group">
                  <div className="task-group-head">
                    <span className="task-group-title">🧩 {String(feature.properties.title)}</span>
                    <span className="badge badge-agent">
                      {featureTasks.length} {isEs ? "Tareas" : "Tasks"}
                    </span>
                    <button
                      type="button"
                      className="btn-small"
                      onClick={() => handleAddTask(feature.id)}
                      title={isEs ? "Nueva tarea bajo esta Feature" : "New task under this Feature"}
                    >
                      + {isEs ? "Tarea" : "Task"}
                    </button>
                  </div>

                  {featureTasks.map((task) => renderTaskCard(task))}

                  {featureTasks.length === 0 && (
                    <p className="card-desc" style={{ paddingLeft: "8px" }}>
                      {isEs
                        ? "Sin tareas todavía. El Arquitecto las creará, o agrégalas con '+ Tarea'."
                        : "No tasks yet. The Architect will add them, or use '+ Task'."}
                    </p>
                  )}
                </div>
              );
            })}

            {/* A task with no HAS_TASK edge estimates nothing and is skipped by
                the dirty cascade. Surfaced here so it can be linked. */}
            {orphanTasks.length > 0 && (
              <div className="task-group task-group-orphan">
                <div className="task-group-head">
                  <span className="task-group-title">
                    ⚠️ {isEs ? "Tareas sin Feature" : "Tasks with no Feature"}
                  </span>
                  <span className="badge badge-dirty">{orphanTasks.length}</span>
                </div>
                {orphanTasks.map((task) => renderTaskCard(task))}
              </div>
            )}

            {tasks.length === 0 && features.length === 0 && (
              <p className="card-desc">
                {isEs
                  ? "Las tareas con puntos y descripción Qué/Cómo aparecerán aquí al ejecutar el Arquitecto o al agregar '+ Nueva Tarea'."
                  : "Tasks with story points and What/How descriptions will appear here when the Architect runs or when you click '+ Add Task'."}
              </p>
            )}
          </div>
        </div>

        {/* Column 3: Shared Consensus, Assumptions, Risks & Live Graph */}
        <div className="column">
          <div className="column-head">
            <h2>
              <span>🌐</span> {isEs ? "Grafo, Suposiciones y Riesgos" : "Live Graph & Governance"}
            </h2>
            <span className="badge badge-agent">{risks.length + assumptions.length} Items</span>
          </div>

          <div className="mermaid-container mermaid-all" title={isEs ? "Todos los nodos como Mermaid" : "All nodes as Mermaid"}>
            <collab-mermaid
              ref={allMermaidRef}
              visible-types="Epic,Feature,C4DiagramElement,Task,Risk,Assumption"
              theme="dark"
            />
          </div>

          {/* Embedded Drop-in <collab-graph> from @collabnode/graph-view */}
          <div className="graph-container">
            <collab-graph ref={graphRef} toolbar="false" inspector="false" editable="false" />
          </div>

          {/* Interactive Assumptions List */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: "14px", fontWeight: 700 }}>
                💡 {isEs ? "Suposiciones y Validación (HITL)" : "Assumptions & Validation (HITL)"}
              </h3>
              <button type="button" className="btn-small" onClick={handleAddAssumption}>
                + {isEs ? "Suposición" : "Add Assumption"}
              </button>
            </div>

            {assumptions.map((assump) => {
              const status = String(assump.properties.status ?? "pending");
              return (
                <div
                  key={assump.id}
                  style={{
                    background: "#090d16",
                    border: `1px solid ${
                      assump.properties.dirty === true
                        ? "var(--warning)"
                        : status === "approved"
                        ? "var(--success)"
                        : status === "rejected"
                        ? "var(--danger)"
                        : "var(--warning)"
                    }`,
                    padding: "8px 10px",
                    borderRadius: "6px",
                    fontSize: "12px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ fontWeight: 600 }}>
                      {String(assump.properties.title)}
                      {assump.properties.dirty === true && (
                        <span className="badge badge-dirty" style={{ marginLeft: "6px" }}>
                          {isEs ? "Sin revisar" : "Dirty"}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: "4px" }}>
                      <button type="button" className="btn-icon" onClick={() => handleEditAssumption(assump.id)}>
                        ✏️
                      </button>
                      <button type="button" className="btn-icon" onClick={() => handleDeleteAssumption(assump.id)}>
                        🗑️
                      </button>
                    </div>
                  </div>

                  <div style={{ color: "var(--text-muted)", marginTop: "2px" }}>
                    {String(assump.properties.description)}
                  </div>

                  {/* Inline Approve / Reject Actions directly on the card */}
                  <div
                    style={{
                      marginTop: "6px",
                      display: "flex",
                      gap: "6px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        color:
                          status === "approved"
                            ? "var(--success)"
                            : status === "rejected"
                            ? "var(--danger)"
                            : "var(--warning)",
                      }}
                    >
                      [{status}]
                    </span>

                    {status === "pending" && (
                      <>
                        <button
                          type="button"
                          className="btn-approve"
                          style={{ fontSize: "11px", padding: "2px 8px" }}
                          onClick={() => handleValidation(assump.id, true)}
                        >
                          ✓ {isEs ? "Aprobar" : "Approve"}
                        </button>
                        <button
                          type="button"
                          className="btn-reject"
                          style={{ fontSize: "11px", padding: "2px 8px" }}
                          onClick={() => handleValidation(assump.id, false)}
                        >
                          ✗ {isEs ? "Rechazar" : "Reject"}
                        </button>
                      </>
                    )}

                    {assump.properties.userComment && (
                      <span style={{ color: "#cbd5e1", fontStyle: "italic", fontSize: "11px" }}>
                        "{String(assump.properties.userComment)}"
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Interactive Risks List */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: "14px", fontWeight: 700 }}>
                🛡️ {isEs ? "Riesgos y Mitigación" : "Risks & Mitigations"}
              </h3>
              <button type="button" className="btn-small" onClick={handleAddRisk}>
                + {isEs ? "Riesgo" : "Add Risk"}
              </button>
            </div>

            {risks.map((risk) => (
              <div
                key={risk.id}
                style={{
                  background: "#090d16",
                  borderLeft: `3px solid ${
                    risk.properties.category === "technical" ? "var(--purple)" : "var(--danger)"
                  }`,
                  padding: "8px 10px",
                  borderRadius: "4px",
                  fontSize: "12px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 600 }}>
                    {String(risk.properties.title)}
                    {risk.properties.dirty === true && (
                      <span className="badge badge-dirty" style={{ marginLeft: "6px" }}>
                        {isEs ? "Sin revisar" : "Dirty"}
                      </span>
                    )}
                  </div>
                  <button type="button" className="btn-icon" onClick={() => handleDeleteRisk(risk.id)}>
                    🗑️
                  </button>
                </div>
                <div style={{ color: "var(--text-muted)" }}>{String(risk.properties.description)}</div>
                {risk.properties.mitigation && (
                  <div style={{ color: "var(--cyan)", marginTop: "4px" }}>
                    <strong>{isEs ? "Mitigación:" : "Mitigation:"}</strong> {String(risk.properties.mitigation)}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Live Agent Activity Log */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <h3 style={{ fontSize: "14px", fontWeight: 700 }}>
              📜 {isEs ? "Registro de Actividad de Agentes" : "Agent Activity Log"}
            </h3>
            <div className="log-box">
              {agentLogs.map((log, i) => (
                <div key={i} className="log-entry">
                  <span className={`log-actor ${log.actor}`}>[{log.actor.toUpperCase()}]</span>
                  <span className="log-text">{log.text}</span>
                </div>
              ))}
              {agentLogs.length === 0 && (
                <div style={{ color: "var(--text-muted)" }}>
                  {isEs ? "No hay registros aún en este espacio." : "No logs recorded yet in this workspace."}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

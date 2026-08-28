import { MemorySaver } from "@langchain/langgraph";
import type { WorkspaceType } from "collabnode";
import {
  createSubAgentConfig,
  createWorkspaceDeepAgent,
  type DeepAgentConfigOptions,
  type ToolCallEvent,
} from "@collabnode/deepagents";
import { singletonOfType, type PlannerSession } from "./session.ts";
import { getChatModel } from "./llm.ts";
import { sharedMicrosoftLearnTools } from "./learn.ts";
import type { AgentLog, PlannerLanguage } from "./types.ts";

export class CrewBusyError extends Error {
  constructor(workspaceId: string) {
    super(`Planner crew is already running for ${workspaceId}`);
    this.name = "CrewBusyError";
  }
}

export class NoModelError extends Error {
  constructor() {
    super("No LLM configured. Set AZURE_OPENAI_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.");
    this.name = "NoModelError";
  }
}

export interface CrewPrompts {
  managerPrompt?: string;
  architectPrompt?: string;
}

interface CrewHandle {
  workspaceId: string;
  language: PlannerLanguage;
  agent: ReturnType<typeof createWorkspaceDeepAgent>;
  logs: AgentLog[];
  running: boolean;
  lastAgent: "none" | "manager" | "architect";
  managerPrompt?: string;
  architectPrompt?: string;
}

const crews = new Map<string, CrewHandle>();

function actorOf(event: ToolCallEvent): "manager" | "architect" {
  return event.actorId === "ai-architect" ? "architect" : "manager";
}

function clip(value: unknown, max = 220): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function pushLog(crew: CrewHandle, actor: AgentLog["actor"], text: string): void {
  const line = text.trim();
  if (!line) return;
  const last = crew.logs[crew.logs.length - 1];
  if (last && last.actor === actor && last.text === line) {
    return;
  }
  crew.logs.push({ actor, text: line, at: new Date().toISOString() });
  if (crew.logs.length > 200) {
    crew.logs.splice(0, crew.logs.length - 200);
  }
  if (process.env.COLLAB_CREW_LOG === "1") {
    console.log(`[${actor}] ${line}`);
  }
}

function pushRolling(crew: CrewHandle, actor: AgentLog["actor"], prefix: string, delta: string): void {
  const piece = clip(delta, 240);
  if (!piece) return;
  const last = crew.logs[crew.logs.length - 1];
  if (last && last.actor === actor && last.text.startsWith(prefix)) {
    const body = last.text.slice(prefix.length).trim();
    last.text = `${prefix}${clip(`${body} ${piece}`, 420)}`;
    last.at = new Date().toISOString();
    return;
  }
  pushLog(crew, actor, `${prefix}${piece}`);
}

function actorFromNamespace(ns: unknown, fallback: "manager" | "architect"): "manager" | "architect" {
  const parts = Array.isArray(ns) ? ns.map(String) : [];
  if (parts.some((p) => /architect/i.test(p))) return "architect";
  return fallback;
}

type StreamModeName = "messages" | "tools" | "updates" | "values" | "debug" | "tasks" | "custom" | "checkpoints";

function decodeChunk(chunk: unknown): { ns: unknown; mode: string; data: unknown } {
  if (Array.isArray(chunk) && chunk.length >= 2) {
    const modes: StreamModeName[] = [
      "messages",
      "tools",
      "updates",
      "values",
      "debug",
      "tasks",
      "custom",
      "checkpoints",
    ];
    if (chunk.length >= 3 && typeof chunk[1] === "string" && modes.includes(chunk[1] as StreamModeName)) {
      return { ns: chunk[0], mode: chunk[1], data: chunk[2] };
    }
    if (typeof chunk[0] === "string" && modes.includes(chunk[0] as StreamModeName)) {
      return { ns: [], mode: chunk[0], data: chunk[1] };
    }
  }
  return { ns: [], mode: "unknown", data: chunk };
}

function messageContentText(content: unknown): { thinking: string; text: string } {
  if (typeof content === "string") {
    return { thinking: "", text: content };
  }
  if (!Array.isArray(content)) {
    return { thinking: "", text: "" };
  }
  const thinking: string[] = [];
  const text: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      text.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const rec = part as Record<string, unknown>;
    const kind = String(rec.type ?? rec.kind ?? "");
    const body = String(rec.text ?? rec.thinking ?? rec.summary ?? rec.reasoning ?? "");
    if (/reason|think/i.test(kind)) {
      thinking.push(body);
    } else if (body) {
      text.push(body);
    }
  }
  return { thinking: thinking.join(" "), text: text.join(" ") };
}

function extraThinking(message: Record<string, unknown>): string {
  const extra = (message.additional_kwargs ?? {}) as Record<string, unknown>;
  const candidates = [extra.reasoning, extra.reasoning_content, extra.thinking, message.reasoning];
  const parts: string[] = [];
  for (const value of candidates) {
    if (typeof value === "string") parts.push(value);
    else if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      parts.push(String(rec.summary ?? rec.content ?? rec.text ?? ""));
    }
  }
  return parts.filter(Boolean).join(" ");
}

function consumeStreamChunk(
  crew: CrewHandle,
  session: PlannerSession,
  chunk: unknown,
): void {
  const { ns, mode, data } = decodeChunk(chunk);
  const who = actorFromNamespace(ns, crew.lastAgent === "architect" ? "architect" : "manager");

  if (mode === "updates" && data && typeof data === "object") {
    for (const node of Object.keys(data as Record<string, unknown>)) {
      pushLog(crew, who, `▸ ${node}`);
    }
  }

  if (mode === "tools" && data && typeof data === "object") {
    const event = data as { event?: string; name?: string; input?: unknown; output?: unknown; error?: unknown };
    const name = event.name || "tool";
    if (name === "task") {
      crew.lastAgent = "architect";
      void setActiveAgent(session, "architect", "ai-architect");
    } else if (who === "architect" && crew.lastAgent !== "architect") {
      crew.lastAgent = "architect";
      void setActiveAgent(session, "architect", "ai-architect");
    } else if (who === "manager" && crew.lastAgent !== "manager") {
      crew.lastAgent = "manager";
      void setActiveAgent(session, "manager", "ai-manager");
    }
    if (event.event === "on_tool_start") {
      pushLog(crew, who, `🔧 ${name}${event.input !== undefined ? ` ${clip(event.input)}` : ""}`);
    } else if (event.event === "on_tool_error") {
      pushLog(crew, who, `⚠️ ${name} failed: ${clip(event.error, 160)}`);
    }
    return;
  }

  if (mode !== "messages") return;

  const tuple = Array.isArray(data) ? data : [data];
  const message = tuple[0];
  if (!message || typeof message !== "object") return;
  const rec = message as Record<string, unknown>;
  const getType = rec._getType;
  const type = String(
    rec.type ?? (typeof getType === "function" ? (getType as () => unknown)() : ""),
  );
  if (type === "human" || type === "tool") return;

  const thought = extraThinking(rec) || messageContentText(rec.content).thinking;
  const spoken = messageContentText(rec.content).text;
  const calls = Array.isArray(rec.tool_calls)
    ? rec.tool_calls
    : Array.isArray(rec.tool_call_chunks)
      ? rec.tool_call_chunks
      : [];
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const recCall = call as { name?: string; args?: unknown; args_chunk?: unknown };
    if (recCall.name) {
      pushLog(
        crew,
        who,
        `🔧 ${recCall.name}${recCall.args !== undefined ? ` ${clip(recCall.args)}` : ""}`,
      );
    }
  }
  if (thought) {
    pushRolling(crew, who, "thinking: ", thought);
  }
  if (spoken) {
    pushRolling(crew, who, "", spoken);
  }
}

async function setActiveAgent(
  session: PlannerSession,
  who: "none" | "manager" | "architect",
  actorId: string,
): Promise<void> {
  await session.upsertNode(
    { type: "SolutionState", properties: { activeAgent: who } },
    { actorId },
  );
}

function samePrompts(crew: CrewHandle, prompts?: CrewPrompts): boolean {
  return crew.managerPrompt === prompts?.managerPrompt && crew.architectPrompt === prompts?.architectPrompt;
}

async function buildCrew(
  workspaceId: string,
  session: PlannerSession,
  workspaceType: WorkspaceType,
  language: PlannerLanguage,
  prompts?: CrewPrompts,
): Promise<CrewHandle> {
  const model = getChatModel();
  if (!model) {
    throw new NoModelError();
  }

  const handle: CrewHandle = {
    workspaceId,
    language,
    agent: undefined as unknown as ReturnType<typeof createWorkspaceDeepAgent>,
    logs: [],
    running: false,
    lastAgent: "none",
    managerPrompt: prompts?.managerPrompt,
    architectPrompt: prompts?.architectPrompt,
  };

  const onToolCall = (event: ToolCallEvent) => {
    const who = actorOf(event);
    pushLog(
      handle,
      who,
      `🔧 ${event.name}${event.args ? ` ${clip(event.args)}` : ""}`,
    );
    if (handle.lastAgent !== who) {
      handle.lastAgent = who;
      void setActiveAgent(session, who, event.actorId);
    }
  };

  const learn = await sharedMicrosoftLearnTools();
  // Views are the read path. Raw graph_* tools duplicate them and burn
  // recursion steps (each inspect is a model round).
  const excludedTools = [
    "graph_describe",
    "graph_list",
    "graph_get",
    "graph_search",
    "graph_similar",
    "graph_neighbors",
    "graph_snapshot",
    "graph_query",
    "graph_history",
    "graph_changes",
    "graph_actors",
    "graph_diff_since",
    "graph_apply_batch",
  ];
  const architect = createSubAgentConfig({
    session: session.as(),
    workspaceType,
    role: "architect",
    language,
    extraTools: learn.tools,
    excludedTools,
    systemPromptSuffix: learn.instructions,
    systemPromptOverride: prompts?.architectPrompt,
    onToolCall,
  });

  handle.agent = createWorkspaceDeepAgent({
    session: session.as(),
    workspaceType,
    role: "manager",
    language,
    model,
    excludedTools,
    checkpointer: new MemorySaver(),
    subagents: [architect] as unknown as DeepAgentConfigOptions["subagents"],
    systemPromptOverride: prompts?.managerPrompt,
    onToolCall,
  });

  return handle;
}

export async function getCrew(
  workspaceId: string,
  session: PlannerSession,
  workspaceType: WorkspaceType,
  language: PlannerLanguage,
  prompts?: CrewPrompts,
): Promise<CrewHandle> {
  const existing = crews.get(workspaceId);
  if (existing && existing.language === language && samePrompts(existing, prompts)) {
    return existing;
  }
  const created = await buildCrew(workspaceId, session, workspaceType, language, prompts);
  if (existing) {
    created.logs = existing.logs;
  }
  crews.set(workspaceId, created);
  return created;
}

export function dropCrew(workspaceId: string): void {
  crews.delete(workspaceId);
}

export function crewLogs(workspaceId: string): AgentLog[] {
  return crews.get(workspaceId)?.logs ?? [];
}

export function crewRunning(workspaceId: string): boolean {
  return crews.get(workspaceId)?.running === true;
}

async function finishTurn(session: PlannerSession): Promise<void> {
  const snap = session.snapshot();
  const pending = snap.nodes.find(
    (n) => n.type === "Assumption" && n.properties.status === "pending",
  );
  const state = singletonOfType(snap, "SolutionState");
  const managerAgrees = state?.properties.managerAgrees === true;
  const architectAgrees = state?.properties.architectAgrees === true;

  if (pending) {
    await session.upsertNode(
      {
        type: "SolutionState",
        properties: {
          status: "waiting_user_validation",
          pendingAssumptionId: pending.id,
          activeAgent: "none",
        },
      },
      { actorId: "ai-manager" },
    );
    return;
  }

  await session.upsertNode(
    {
      type: "SolutionState",
      properties: {
        status: managerAgrees && architectAgrees ? "approved" : "planning",
        pendingAssumptionId: null,
        activeAgent: "none",
      },
    },
    { actorId: "ai-manager" },
  );
}

export async function runPlannerChat(options: {
  workspaceId: string;
  session: PlannerSession;
  workspaceType: WorkspaceType;
  message: string;
  language: PlannerLanguage;
  actor?: AgentLog["actor"];
  managerPrompt?: string;
  architectPrompt?: string;
}): Promise<{ logs: AgentLog[] }> {
  const { workspaceId, session, workspaceType, message, language, actor = "user" } = options;
  const crew = await getCrew(workspaceId, session, workspaceType, language, {
    managerPrompt: options.managerPrompt,
    architectPrompt: options.architectPrompt,
  });
  if (crew.running) {
    throw new CrewBusyError(workspaceId);
  }

  crew.running = true;
  crew.lastAgent = "manager";
  pushLog(crew, actor, message);
  pushLog(crew, "manager", "starting…");

  const state = singletonOfType(session.snapshot(), "SolutionState");
  const iteration = Number(state?.properties.iteration ?? 0) + 1;
  await session.upsertNode(
    {
      type: "SolutionState",
      properties: {
        description: state?.properties.description?.trim()
          ? state.properties.description
          : message,
        language,
        status: "planning",
        activeAgent: "manager",
        iteration,
        managerAgrees: false,
        architectAgrees: false,
      },
    },
    { actorId: "human-user" },
  );

  const abort = new AbortController();
  const wallMs = Number(process.env.PLANNER_TURN_MS ?? 180_000);
  const kill = setTimeout(() => abort.abort(), wallMs);
  try {
    const stream = await crew.agent.stream(
      { messages: [{ role: "user", content: message }] },
      {
        configurable: { thread_id: workspaceId },
        streamMode: ["updates", "messages", "tools"],
        subgraphs: true,
        // Supersteps are cheap to blow: each model round + tools is ~2.
        // Architect used to loop view→write→view until this hit 40 (~$$).
        // Shared with the architect subgraph. 28 ≈ 14 model rounds total
        // (manager writes + one task + a short C4). Prompt says stop; this
        // is the cost cap if they don't.
        recursionLimit: 28,
        signal: abort.signal,
      },
    );
    for await (const chunk of stream) {
      consumeStreamChunk(crew, session, chunk);
    }
    await finishTurn(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const capped =
      abort.signal.aborted ||
      /recursion limit/i.test(msg) ||
      (err as { lc_error_code?: string }).lc_error_code === "GRAPH_RECURSION_LIMIT";
    pushLog(crew, "system", capped ? `stopped: ${clip(msg, 160)}` : msg);
    await finishTurn(session);
    if (!capped) {
      throw err;
    }
  } finally {
    clearTimeout(kill);
    crew.running = false;
  }

  return { logs: crew.logs };
}

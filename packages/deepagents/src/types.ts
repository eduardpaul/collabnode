import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { CollabSession } from "@collabnode/runtime";
import type { AgentDef, GraphSchema, WorkspaceType } from "@collabnode/schema";

export type SupportedLanguage = "en" | "es" | string;

export interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  actorId: string;
  timestamp: number;
}

export interface DeepAgentConfigOptions {
  /** CollabSession instance to bind tools and state mutations to. */
  session: CollabSession;
  /** Full workspace definition containing schema and agent declarations. */
  workspaceType?: WorkspaceType;
  /** Raw GraphSchema if workspaceType is not provided. */
  schema?: GraphSchema;
  /** Agent role name from schema (e.g. 'manager', 'architect'). */
  role?: string;
  /** Specific actor ID used for CRDT stamping (defaults to agent definition or session actor). */
  actorId?: string;
  /** ISO-639 language code for prompt generation and tool descriptions. Defaults to 'en'. */
  language?: SupportedLanguage;
  /** Chat model instance or provider:model string. */
  model?: BaseChatModel | string;
  /** Additional domain tools (e.g. Microsoft Learn MCP tools, web search). */
  extraTools?: StructuredToolInterface[];
  /** Tool names to exclude from the agent's tool surface. */
  excludedTools?: string[];
  /** Additional LangChain / DeepAgents middleware. */
  extraMiddleware?: any[];
  /** Custom suffix appended to the assembled system prompt. */
  systemPromptSuffix?: string;
  /** Complete override for the system prompt (bypasses schema generation). */
  systemPromptOverride?: string;
  /**
   * Whether to enable task planning / todo list for this agent (TodoListMiddleware / write_todos).
   * If not provided, falls back to `agentDef.internalPlanning` in schema.
   */
  internalPlanning?: boolean;
  /** Human-in-the-loop interrupt configuration. */
  interruptOn?: Record<string, boolean | { allowedDecisions?: string[] }>;
  /** Custom filesystem backend (defaults to StateBackend in deepagents). */
  backend?: any;
  /** Checkpointer for persistence and human-in-the-loop support. */
  checkpointer?: any;
  /** Durable cross-thread store. */
  store?: any;
  /** Subagent configurations to attach. */
  subagents?: any[];
  /** Optional callback invoked on every tool execution for logging and observability. */
  onToolCall?: (event: ToolCallEvent) => void;
}

/**
 * The configuration object prepared by Collabnode, directly consumable by `createDeepAgent(config)`
 * or customizable by the caller before agent creation.
 */
export interface CollabDeepAgentConfig {
  model?: BaseChatModel | string;
  systemPrompt: string;
  tools: StructuredToolInterface[];
  middleware?: any[];
  interruptOn?: Record<string, any>;
  subagents?: any[];
  backend?: any;
  checkpointer?: any;
  store?: any;
  actorId: string;
  role?: string;
  language: string;
  internalPlanning: boolean;
  agentDef?: AgentDef;
}

export interface SubAgentConfigOptions {
  session: CollabSession;
  workspaceType?: WorkspaceType;
  schema?: GraphSchema;
  role: string;
  language?: SupportedLanguage;
  extraTools?: StructuredToolInterface[];
  excludedTools?: string[];
  systemPromptSuffix?: string;
  onToolCall?: (event: ToolCallEvent) => void;
}

export interface CollabSubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: StructuredToolInterface[];
  model?: BaseChatModel | string;
  interruptOn?: Record<string, any>;
}

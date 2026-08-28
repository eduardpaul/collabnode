import { todoListMiddleware } from "langchain";
import { createDeepAgent } from "deepagents";
import { bindAgentTools } from "./tools.js";
import { buildAgentSystemPrompt } from "./prompts.js";
import type {
  CollabDeepAgentConfig,
  CollabSubAgentConfig,
  DeepAgentConfigOptions,
  SubAgentConfigOptions,
} from "./types.js";
import { resolveI18nString, type AgentDef } from "@collabnode/schema";

/**
 * Finds an agent definition by role or actorId within the workspace schema.
 */
export function findAgentDef(
  options: DeepAgentConfigOptions | SubAgentConfigOptions,
): AgentDef | undefined {
  const { workspaceType, role } = options;
  if (!role || !workspaceType?.tools?.agents) {
    return undefined;
  }
  return workspaceType.tools.agents.find(
    (agent) => agent.role === role || agent.actorId === role,
  );
}

/**
 * Generates a complete, ready-to-use DeepAgent configuration object from Collabnode schema and session.
 * 
 * Library consumers can inspect, tweak, or extend this configuration before creating the agent,
 * or pass it directly to `createDeepAgent(config)`.
 */
export function getDeepAgentConfig(options: DeepAgentConfigOptions): CollabDeepAgentConfig {
  const {
    session,
    workspaceType,
    schema = workspaceType?.schema ?? session.schema,
    role,
    language = "en",
    model,
    extraTools = [],
    excludedTools = [],
    extraMiddleware = [],
    systemPromptSuffix,
    systemPromptOverride,
    checkpointer,
    backend,
    store,
    subagents,
    onToolCall,
  } = options;

  const agentDef = findAgentDef(options);
  const actorId = options.actorId ?? agentDef?.actorId ?? session.actorId ?? "agent";

  // 1. Bind schema tools to the live CollabSession, stamped with actorId and respecting access policies
  const tools = bindAgentTools({
    session,
    schema,
    toolsPolicy: workspaceType?.tools,
    views: workspaceType?.views,
    agentDef,
    actorId,
    language,
    extraTools,
    excludedTools,
    onToolCall,
  });

  // 2. Assemble context-engineered system prompt
  const systemPrompt = buildAgentSystemPrompt({
    schema,
    workspaceType,
    agentDef,
    documentId: session.id,
    language,
    systemPromptSuffix,
    systemPromptOverride,
  });

  // 3. Assemble middleware
  const middleware: any[] = [...extraMiddleware];

  // Enable task planning (write_todos / TodoListMiddleware) if requested or declared in schema
  const internalPlanning = options.internalPlanning ?? agentDef?.internalPlanning ?? false;
  if (internalPlanning) {
    middleware.push(todoListMiddleware());
  }

  // 4. Resolve Human-in-the-Loop interrupt configuration
  const interruptOn = options.interruptOn ?? undefined;

  return {
    model,
    systemPrompt,
    tools,
    middleware: middleware.length > 0 ? middleware : undefined,
    interruptOn,
    subagents,
    backend,
    checkpointer,
    store,
    actorId,
    role,
    language,
    internalPlanning,
    agentDef,
  };
}

/**
 * Prepares a subagent configuration suitable for passing into `subagents: [...]` of `createDeepAgent`.
 */
export function createSubAgentConfig(options: SubAgentConfigOptions): CollabSubAgentConfig {
  const {
    session,
    workspaceType,
    schema = workspaceType?.schema ?? session.schema,
    role,
    language = "en",
    extraTools = [],
    excludedTools = [],
    systemPromptSuffix,
    onToolCall,
  } = options;

  const agentDef = findAgentDef(options);
  const actorId = agentDef?.actorId ?? session.actorId ?? "agent";

  const tools = bindAgentTools({
    session,
    schema,
    // Without the workspace policy a subagent bypasses `tools.expose` and the
    // per-role `nodes.readOnly` list that the parent agent is held to.
    toolsPolicy: workspaceType?.tools,
    agentDef,
    actorId,
    language,
    extraTools,
    excludedTools,
    onToolCall,
  });

  const systemPrompt = buildAgentSystemPrompt({
    schema,
    workspaceType,
    agentDef,
    documentId: session.id,
    language,
    systemPromptSuffix,
  });

  const description = agentDef?.description
    ? resolveI18nString(agentDef.description, language) ?? `Specialized ${role} agent`
    : `Specialized ${role} agent`;

  return {
    name: role,
    description,
    systemPrompt,
    tools,
  };
}

/**
 * Convenience helper to instantiate a compiled DeepAgent directly from Collabnode configuration.
 */
export function createWorkspaceDeepAgent(options: DeepAgentConfigOptions) {
  const config = getDeepAgentConfig(options);
  return createDeepAgent(config as any);
}

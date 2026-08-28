import { todoListMiddleware } from "langchain";
import { createDeepAgent } from "deepagents";
import { bindAgentTools } from "./tools.js";
import { buildAgentSystemPrompt } from "./prompts.js";
import type {
  CollabDeepAgentConfig,
  CollabSubAgentConfig,
  DeepAgentConfigOptions,
  DeepAgentMiddleware,
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
 * The subset of `CollabDeepAgentConfig` that `createDeepAgent` actually takes.
 *
 * Actor / role / language / agentDef stay on the Collab config for inspection;
 * passing them through would be ignored at best and a type error at worst.
 */
type CreateDeepAgentInput = NonNullable<Parameters<typeof createDeepAgent>[0]>;

export function toCreateDeepAgentParams(config: CollabDeepAgentConfig): CreateDeepAgentInput {
  return {
    model: config.model,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    middleware: config.middleware,
    interruptOn: config.interruptOn,
    subagents: config.subagents,
    backend: config.backend,
    checkpointer: config.checkpointer,
    store: config.store,
  };
}

/**
 * Generates a complete, ready-to-use DeepAgent configuration object from Collabnode schema and session.
 *
 * Library consumers can inspect, tweak, or extend this configuration before creating the agent,
 * or pass `toCreateDeepAgentParams(config)` to `createDeepAgent`.
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

  const systemPrompt = buildAgentSystemPrompt({
    schema,
    workspaceType,
    agentDef,
    documentId: session.id,
    language,
    systemPromptSuffix,
    systemPromptOverride,
  });

  const middleware: DeepAgentMiddleware[] = [...extraMiddleware];
  const internalPlanning = options.internalPlanning ?? agentDef?.internalPlanning ?? false;
  if (internalPlanning) {
    middleware.push(todoListMiddleware());
  }

  return {
    model,
    systemPrompt,
    tools,
    middleware: middleware.length > 0 ? middleware : undefined,
    interruptOn: options.interruptOn,
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
    views: workspaceType?.views,
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
 * Instantiates a compiled DeepAgent from Collabnode configuration.
 *
 * Only the keys `createDeepAgent` documents are forwarded.
 */
export function createWorkspaceDeepAgent(options: DeepAgentConfigOptions) {
  return createDeepAgent(toCreateDeepAgentParams(getDeepAgentConfig(options)));
}

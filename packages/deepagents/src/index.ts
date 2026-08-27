export {
  getDeepAgentConfig,
  createSubAgentConfig,
  createWorkspaceDeepAgent,
  findAgentDef,
} from "./config.js";

export {
  bindAgentTools,
  type BindAgentToolsOptions,
} from "./tools.js";

export {
  buildAgentSystemPrompt,
  type BuildPromptOptions,
} from "./prompts.js";

export type {
  SupportedLanguage,
  ToolCallEvent,
  DeepAgentConfigOptions,
  CollabDeepAgentConfig,
  SubAgentConfigOptions,
  CollabSubAgentConfig,
} from "./types.js";

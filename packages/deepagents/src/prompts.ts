import { systemPromptText } from "@collabnode/mcp";
import { resolveI18nString, type AgentDef, type GraphSchema, type WorkspaceType } from "@collabnode/schema";

export interface BuildPromptOptions {
  schema: GraphSchema;
  workspaceType?: WorkspaceType;
  agentDef?: AgentDef;
  documentId: string;
  language?: string;
  systemPromptSuffix?: string;
  systemPromptOverride?: string;
}

/**
 * Assembles the full system prompt for a Deep Agent using Collabnode schema contracts,
 * guidelines, access policies, and role definitions.
 */
export function buildAgentSystemPrompt(options: BuildPromptOptions): string {
  const {
    schema,
    workspaceType,
    agentDef,
    documentId,
    language = "en",
    systemPromptSuffix,
    systemPromptOverride,
  } = options;

  if (systemPromptOverride) {
    return systemPromptSuffix
      ? `${systemPromptOverride.trim()}\n\n${systemPromptSuffix.trim()}`
      : systemPromptOverride.trim();
  }

  const promptSections: string[] = [];

  // 1. Role-specific prompt from YAML schema
  if (agentDef?.systemPrompt) {
    const rolePrompt = resolveI18nString(agentDef.systemPrompt, language);
    if (rolePrompt?.trim()) {
      promptSections.push(rolePrompt.trim());
    }
  } else if (agentDef?.description) {
    const roleDesc = resolveI18nString(agentDef.description, language);
    if (roleDesc?.trim()) {
      promptSections.push(roleDesc.trim());
    }
  }

  // 2. Collabnode Schema contract (node types, property types, required rules, edge types, access policy)
  const schemaContract = systemPromptText(
    schema,
    {
      documentId,
      actorId: agentDef?.actorId,
      type: workspaceType,
      agentRole: agentDef?.role,
      language,
    },
    language,
  );

  if (schemaContract?.trim()) {
    promptSections.push(schemaContract.trim());
  }

  // 3. System prompt suffix (if provided)
  if (systemPromptSuffix?.trim()) {
    promptSections.push(systemPromptSuffix.trim());
  }

  return promptSections.join("\n\n");
}

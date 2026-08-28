import { systemPromptText } from "@collabnode/mcp";
import {
  resolveI18nString,
  toolListAllowsAll,
  type AgentDef,
  type GraphSchema,
  type WorkspaceType,
} from "@collabnode/schema";

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

  // 3. The views this role is granted, by tool name.
  //
  // Views are declarative graph slices; the model can only call them if it knows
  // they exist, and the tool list alone buries them among the generated
  // `graph_*` tools. Naming them here is what turns a declared view into one the
  // agent actually reaches for.
  const viewsBlock = describeAgentViews(workspaceType, agentDef, language);
  if (viewsBlock) {
    promptSections.push(viewsBlock);
  }

  // 4. System prompt suffix (if provided)
  if (systemPromptSuffix?.trim()) {
    promptSections.push(systemPromptSuffix.trim());
  }

  return promptSections.join("\n\n");
}

/**
 * A short catalogue of the views this role may call, or `undefined` when the
 * workspace declares none or the role is granted none.
 */
function describeAgentViews(
  workspaceType: BuildPromptOptions["workspaceType"],
  agentDef: BuildPromptOptions["agentDef"],
  language: string,
): string | undefined {
  const views = workspaceType?.views;
  if (!views || Object.keys(views).length === 0) {
    return undefined;
  }
  const grantsAll = toolListAllowsAll(agentDef?.views);
  const granted = grantsAll ? undefined : new Set(agentDef?.views);

  const lines: string[] = [];
  for (const [name, view] of Object.entries(views)) {
    if (granted && !granted.has(name)) {
      continue;
    }
    const title = resolveI18nString(view.title, language);
    const description = resolveI18nString(view.description, language);
    const params = Object.keys(view.params ?? {});
    const signature = params.length > 0 ? `view_${name}(${params.join(", ")})` : `view_${name}`;
    lines.push(`- \`${signature}\`${title ? ` — ${title}` : ""}${description ? `: ${description}` : ""}`);
  }
  if (lines.length === 0) {
    return undefined;
  }
  return [
    "## Views available to you",
    "Call these to read a prepared slice of the graph instead of assembling one yourself.",
    lines.join("\n"),
  ].join("\n\n");
}

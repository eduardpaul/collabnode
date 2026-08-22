import {
  resolveI18nString,
  type GraphSchema,
  type WorkspaceType,
} from "@collabnode/schema";
import {
  formatEdgeContract,
  formatNodeContract,
  formatSystemPromptText,
  getLocale,
  type SupportedLanguage,
} from "./i18n.js";
import { promptName, toolName } from "./names.js";

export interface GeneratedPrompt {
  name: string;
  description: string;
  text: string;
}

export interface PromptContext {
  documentId: string;
  actorId?: string;
  type?: WorkspaceType;
  agentRole?: string;
  language?: SupportedLanguage | string;
}

export function systemPromptText(
  schema: GraphSchema,
  ctx: PromptContext,
  language?: SupportedLanguage | string,
): string {
  return formatSystemPromptText(schema, ctx, language);
}

export function generatePrompts(
  schema: GraphSchema,
  ctx: PromptContext,
  language?: SupportedLanguage | string,
): GeneratedPrompt[] {
  const lang = language ?? ctx.language;
  const t = getLocale(lang);

  const prompts: GeneratedPrompt[] = [
    {
      name: "graph-system",
      description: t.prompts.systemPromptDescription(ctx.type?.name ?? schema.name),
      text: systemPromptText(schema, ctx, lang),
    },
  ];

  if (ctx.type?.tools?.agents) {
    for (const agent of ctx.type.tools.agents) {
      const agentDesc = resolveI18nString(agent.description, lang);
      const agentPrompt = resolveI18nString(agent.systemPrompt, lang);
      prompts.push({
        name: `agent-${agent.role}`,
        description: agentDesc ?? t.prompts.agentRoleDescription(agent.role),
        text: agentPrompt ?? t.prompts.agentActingText(agent.role, ctx.documentId),
      });
    }
  }

  for (const [type, def] of Object.entries(schema.nodes)) {
    const hasDerived = Object.values(def.properties).some((prop) => prop.derived !== undefined);
    const upsertName = toolName("upsert_node", type);
    const callHelp = hasDerived
      ? t.prompts.workOnDerivedCallHelp(upsertName)
      : t.prompts.workOnCallHelp(upsertName);

    prompts.push({
      name: promptName("work-on", type),
      description: t.prompts.workOnDescription(type),
      text: [formatNodeContract(type, def, lang), "", callHelp].join("\n"),
    });
  }

  for (const [type, def] of Object.entries(schema.edges)) {
    const linkName = toolName("upsert_edge", type);
    const callHelp = t.prompts.linkCallHelp(linkName);

    prompts.push({
      name: promptName("link", type),
      description: t.prompts.linkDescription(type),
      text: [formatEdgeContract(type, def, lang), "", callHelp].join("\n"),
    });
  }
  return prompts;
}

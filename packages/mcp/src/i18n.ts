import {
  resolveGuidelines,
  resolveI18nString,
  type EdgeTypeDef,
  type GraphSchema,
  type NodeTypeDef,
  type PropertyDef,
  type WorkspaceType,
} from "@collabnode/schema";
import type { GraphSearchModes } from "@collabnode/runtime";
import { getLocale, type SupportedLanguage } from "./locales/index.js";

export {
  getLocale,
  normalizeLanguage,
  registerLocale,
  type McpLocaleCatalog,
  type SupportedLanguage,
} from "./locales/index.js";

export function formatPropertyLine(
  name: string,
  def: PropertyDef,
  lang?: SupportedLanguage | string,
): string {
  const t = getLocale(lang);
  const bits: string[] = [def.type];
  if (def.type === "enum" && def.values) {
    bits.push(`enum [${def.values.join(", ")}]`);
  }
  if (def.integer) {
    bits.push(t.prompts.propertyKeywords.integer);
  }
  if (def.min !== undefined) {
    bits.push(t.prompts.propertyKeywords.min(def.min));
  }
  if (def.max !== undefined) {
    bits.push(t.prompts.propertyKeywords.max(def.max));
  }
  if (def.maxLength !== undefined) {
    bits.push(t.prompts.propertyKeywords.maxLength(def.maxLength));
  }
  if (def.required) {
    bits.push(t.prompts.propertyKeywords.required);
  }
  if (def.default !== undefined) {
    bits.push(t.prompts.propertyKeywords.default(JSON.stringify(def.default)));
  }
  if (def.derived !== undefined) {
    bits.push(t.prompts.propertyKeywords.derived(JSON.stringify(def.derived)));
  }
  const desc = resolveI18nString(def.description, lang);
  if (desc) {
    bits.push(`(${desc})`);
  }
  return `${name}: ${bits.join(", ")}`;
}

export function partitionProperties(
  properties: Record<string, PropertyDef>,
): { writable: [string, PropertyDef][]; derived: [string, PropertyDef][] } {
  const writable: [string, PropertyDef][] = [];
  const derived: [string, PropertyDef][] = [];
  for (const entry of Object.entries(properties)) {
    if (entry[1].derived !== undefined) {
      derived.push(entry);
    } else {
      writable.push(entry);
    }
  }
  return { writable, derived };
}

export function formatNodeContract(
  type: string,
  def: NodeTypeDef,
  lang?: SupportedLanguage | string,
): string {
  const t = getLocale(lang);
  const lines = [`#### ${type}`];
  const desc = resolveI18nString(def.description, lang);
  if (desc) {
    lines.push(desc);
  }
  if (def.identity?.from.length) {
    lines.push(t.prompts.identityFields(def.identity.from.join(", ")));
  }
  const { writable, derived } = partitionProperties(def.properties);
  if (writable.length > 0) {
    lines.push(t.prompts.propertiesHeader);
    for (const [name, prop] of writable) {
      lines.push(`  * ${formatPropertyLine(name, prop, lang)}`);
    }
  }
  if (derived.length > 0) {
    lines.push(t.prompts.derivedHeader);
    for (const [name, prop] of derived) {
      lines.push(`  * ${formatPropertyLine(name, prop, lang)}`);
    }
  }
  const guidelines = resolveGuidelines(def.guidelines, lang);
  if (guidelines.length > 0) {
    lines.push(t.prompts.guidelinesHeader);
    for (const rule of guidelines) {
      lines.push(`  * ${rule}`);
    }
  }
  return lines.join("\n");
}

export function formatEdgeContract(
  type: string,
  def: EdgeTypeDef,
  lang?: SupportedLanguage | string,
): string {
  const t = getLocale(lang);
  const lines = [`#### ${type}`];
  const desc = resolveI18nString(def.description, lang);
  if (desc) {
    lines.push(desc);
  }
  lines.push(t.prompts.edgeConnects(def.from.join(" | "), def.to.join(" | ")));
  const props = Object.entries(def.properties);
  if (props.length > 0) {
    lines.push(t.prompts.propertiesHeader);
    for (const [name, prop] of props) {
      lines.push(`  * ${formatPropertyLine(name, prop, lang)}`);
    }
  }
  const guidelines = resolveGuidelines(def.guidelines, lang);
  if (guidelines.length > 0) {
    lines.push(t.prompts.guidelinesHeader);
    for (const rule of guidelines) {
      lines.push(`  * ${rule}`);
    }
  }
  return lines.join("\n");
}

export function formatSystemPromptText(
  schema: GraphSchema,
  ctx: {
    documentId: string;
    actorId?: string;
    type?: WorkspaceType;
    agentRole?: string;
    language?: SupportedLanguage | string;
  },
  lang?: SupportedLanguage | string,
): string {
  const currentLang = lang ?? ctx.language;
  const t = getLocale(currentLang);
  const agent =
    ctx.agentRole && ctx.type?.tools?.agents
      ? ctx.type.tools.agents.find(
          (a) => a.role === ctx.agentRole || a.actorId === ctx.agentRole,
        )
      : undefined;

  const agentPrompt = resolveI18nString(agent?.systemPrompt, currentLang);
  const header = agentPrompt
    ? t.prompts.roleHeader(agent!.role, agentPrompt)
    : "";

  const title = ctx.type
    ? t.prompts.collaboratingOnWorkspace(ctx.type.name, ctx.documentId)
    : t.prompts.collaboratingOnGraph(schema.name, schema.config.schemaId, ctx.documentId);

  const rawDescription = ctx.type?.description ?? schema.description;
  const descText = resolveI18nString(rawDescription, currentLang);

  const actorLine = ctx.actorId ? t.prompts.activeActor(ctx.actorId) : undefined;

  const sections: (string | undefined)[] = [
    header ? header.trimEnd() : undefined,
    header ? "" : undefined,
    title,
    descText,
    actorLine,
    "",
    t.prompts.rulesHeader,
    t.prompts.rules.multiParticipant,
    t.prompts.rules.preferTargetedReads,
    t.prompts.rules.searchBeforeCreate,
    t.prompts.rules.identityMatching,
    schema.config.tags?.enabled ? t.prompts.rules.tagsSupported : undefined,
    "",
    t.prompts.nodeTypesHeader,
    Object.entries(schema.nodes)
      .map(([type, def]) => formatNodeContract(type, def, currentLang))
      .join("\n\n") || t.prompts.none,
    "",
    t.prompts.edgeTypesHeader,
    Object.entries(schema.edges)
      .map(([type, def]) => formatEdgeContract(type, def, currentLang))
      .join("\n\n") || t.prompts.none,
  ];

  return sections.filter((line) => line !== undefined).join("\n");
}

export function formatSearchToolDescription(
  modes: GraphSearchModes,
  lang?: SupportedLanguage | string,
): string {
  const t = getLocale(lang);
  return t.tools.search.description(modes);
}

export function formatSimilarToolDescription(lang?: SupportedLanguage | string): string {
  const t = getLocale(lang);
  return t.tools.similar.description;
}

export function formatQueryToolDescription(
  graphKind: string,
  schema?: GraphSchema,
  lang?: SupportedLanguage | string,
): string {
  const t = getLocale(lang);
  const exampleType = schema ? Object.keys(schema.nodes)[0] ?? "Type" : "Type";
  return t.tools.query.description(graphKind, exampleType);
}

export function formatGuidelinesBlurb(
  guidelines: string[] | undefined,
  lang?: SupportedLanguage | string,
): string {
  if (!guidelines?.length) {
    return "";
  }
  const t = getLocale(lang);
  return t.tools.guidelinesBlurb(guidelines.join("; "));
}

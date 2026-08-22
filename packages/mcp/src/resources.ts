import { compactSnapshot, type CollabSession } from "@collabnode/runtime";
import { resolveGuidelines, type GraphSchema } from "@collabnode/schema";
import { getLocale, type SupportedLanguage } from "./i18n.js";

export interface GeneratedResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string>;
}

export interface GenerateResourcesOptions {
  language?: SupportedLanguage | string;
}

export function generateResources(
  schema: GraphSchema,
  session: CollabSession,
  optionsOrLanguage?: GenerateResourcesOptions | string,
): GeneratedResource[] {
  const lang =
    typeof optionsOrLanguage === "string" ? optionsOrLanguage : optionsOrLanguage?.language;
  const t = getLocale(lang);

  const resources: GeneratedResource[] = [
    {
      uri: "collabnode://schema",
      name: "schema",
      description: t.resources.schema(schema.name),
      mimeType: "application/json",
      read: async () => JSON.stringify(schema, null, 2),
    },
    {
      uri: "collabnode://snapshot",
      name: "snapshot",
      description: t.resources.snapshot,
      mimeType: "application/json",
      read: async () => JSON.stringify(compactSnapshot(session.snapshot(), undefined, false), null, 2),
    },
  ];
  for (const type of Object.keys(schema.nodes)) {
    resources.push({
      uri: `collabnode://guidelines/node/${type}`,
      name: `guidelines-node-${type}`,
      description: t.resources.nodeGuidelines(type),
      mimeType: "application/json",
      read: async () =>
        JSON.stringify(resolveGuidelines(schema.nodes[type]?.guidelines, lang), null, 2),
    });
  }
  for (const type of Object.keys(schema.edges)) {
    resources.push({
      uri: `collabnode://guidelines/edge/${type}`,
      name: `guidelines-edge-${type}`,
      description: t.resources.edgeGuidelines(type),
      mimeType: "application/json",
      read: async () =>
        JSON.stringify(resolveGuidelines(schema.edges[type]?.guidelines, lang), null, 2),
    });
  }
  return resources;
}

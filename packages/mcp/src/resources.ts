import { compactSnapshot, type CollabSession } from "@collabnode/runtime";
import {
  openNodeAccess,
  redactSchema,
  resolveGuidelines,
  type GraphSchema,
  type NodeAccessPolicy,
} from "@collabnode/schema";
import { getLocale, type SupportedLanguage } from "./i18n.js";
import { visibleSnapshot } from "./visibility.js";

export interface GeneratedResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string>;
}

export interface GenerateResourcesOptions {
  language?: SupportedLanguage | string;
  /** Node-type reach for this caller; defaults to unrestricted. */
  access?: NodeAccessPolicy;
}

export function generateResources(
  schema: GraphSchema,
  session: CollabSession,
  optionsOrLanguage?: GenerateResourcesOptions | string,
): GeneratedResource[] {
  const lang =
    typeof optionsOrLanguage === "string" ? optionsOrLanguage : optionsOrLanguage?.language;
  const t = getLocale(lang);
  const access =
    (typeof optionsOrLanguage === "string" ? undefined : optionsOrLanguage?.access) ??
    openNodeAccess(schema);
  // Resources are a second door onto the same graph, so they are redacted with
  // the same policy the tools use — a hidden type must not reappear here as a
  // schema dump or a snapshot row.
  const view = redactSchema(schema, access);

  const resources: GeneratedResource[] = [
    {
      uri: "collabnode://schema",
      name: "schema",
      description: t.resources.schema(view.name),
      mimeType: "application/json",
      read: async () => JSON.stringify(view, null, 2),
    },
    {
      uri: "collabnode://snapshot",
      name: "snapshot",
      description: t.resources.snapshot,
      mimeType: "application/json",
      read: async () =>
        JSON.stringify(
          compactSnapshot(visibleSnapshot(session.snapshot(), access), undefined, false),
          null,
          2,
        ),
    },
  ];
  for (const type of Object.keys(view.nodes)) {
    resources.push({
      uri: `collabnode://guidelines/node/${type}`,
      name: `guidelines-node-${type}`,
      description: t.resources.nodeGuidelines(type),
      mimeType: "application/json",
      read: async () =>
        JSON.stringify(resolveGuidelines(view.nodes[type]?.guidelines, lang), null, 2),
    });
  }
  for (const type of Object.keys(view.edges)) {
    resources.push({
      uri: `collabnode://guidelines/edge/${type}`,
      name: `guidelines-edge-${type}`,
      description: t.resources.edgeGuidelines(type),
      mimeType: "application/json",
      read: async () =>
        JSON.stringify(resolveGuidelines(view.edges[type]?.guidelines, lang), null, 2),
    });
  }
  return resources;
}

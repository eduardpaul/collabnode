import type { GraphSchema } from "@collabnode/schema";
import type { CollabJoin } from "./backends.js";
import type { Collabnode } from "./init.js";

export type WebJoinCollab = Extract<CollabJoin, { kind: "fluid" | "hocuspocus" }>;

export interface WebJoinInfo {
  documentId: string;
  schema: GraphSchema;
  collab: WebJoinCollab;
}

export function webJoinInfo(node: Collabnode): WebJoinInfo {
  if (node.collab.kind !== "fluid" && node.collab.kind !== "hocuspocus") {
    throw new Error(
      `webJoinInfo requires a Fluid or Hocuspocus collab backend; this session is '${node.collab.kind}'. Pass documentId and schema to @collabnode/web connect() yourself, or init({ collab: { kind: "fluid" } }) / init({ collab: { kind: "hocuspocus" } }).`,
    );
  }
  return {
    documentId: node.documentId,
    schema: node.schema,
    collab: node.collab,
  };
}

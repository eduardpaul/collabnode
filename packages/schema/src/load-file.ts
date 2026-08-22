import { readFile } from "node:fs/promises";
import { parseSchemaDocument } from "./parse.js";
import type { GraphSchema, WorkspaceType } from "./types.js";
import { parseWorkspaceTypeDocument } from "./workspace-type.js";

export async function loadSchemaFile(path: string): Promise<GraphSchema> {
  const source = await readFile(path, "utf8");
  return parseSchemaDocument(source, path);
}

export async function loadWorkspaceTypeFile(path: string): Promise<WorkspaceType> {
  const source = await readFile(path, "utf8");
  return parseWorkspaceTypeDocument(source, path);
}


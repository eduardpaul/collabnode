import { loadWorkspaceTypeFile, type WorkspaceType } from "collabnode";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedWorkspaceType: WorkspaceType | undefined;

export async function getPlannerWorkspaceType(): Promise<WorkspaceType> {
  if (cachedWorkspaceType) {
    return cachedWorkspaceType;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  cachedWorkspaceType = await loadWorkspaceTypeFile(join(root, "workspaces/solution-planner.yaml"));
  return cachedWorkspaceType;
}

import { InMemoryCollabBackend } from "@collabnode/collab";
import { CollabSession } from "@collabnode/runtime";
import { parseWorkspaceTypeDocument } from "@collabnode/schema";

/** A two-node workspace, small enough that a test can state what it expects. */
export const WORKSPACE_YAML = `
type: plan-fixture
version: 1
description:
  en: Plan Fixture
schema:
  name: PlanFixture
  version: 1
  config:
    schemaId: plan-fixture
    idStrategy: uuid
  nodes:
    Goal:
      properties:
        title:
          type: string
          required: true
    Task:
      properties:
        title:
          type: string
          required: true
        status:
          type: enum
          values: [todo, done]
          default: todo
  edges:
    HAS_TASK:
      from: [Goal]
      to: [Task]
      directed: true

tools:
  expose:
    - upsert_node_Goal
    - upsert_node_Task
    - upsert_edge_HAS_TASK
    - graph_get
    - graph_list
  agents:
    - role: manager
      actorId: ai-manager
      description:
        en: Manager
      systemPrompt:
        en: You are a manager.
      tools:
        - upsert_node_Goal
        - upsert_node_Task
        - graph_get
`;

export const workspaceType = parseWorkspaceTypeDocument(WORKSPACE_YAML);

let docCounter = 0;

export async function createTestSession(): Promise<CollabSession> {
  return await CollabSession.open(`doc-${++docCounter}`, {
    collab: new InMemoryCollabBackend(),
    schema: workspaceType.schema,
    actorId: "server",
  });
}

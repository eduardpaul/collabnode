import type { CollabSession } from "collabnode";

export async function seedBoard(session: CollabSession): Promise<void> {
  if (session.snapshot().nodes.length > 0) {
    return;
  }
  const ada = await session.upsertNode({
    type: "Person",
    properties: { name: "Ada" },
  });

  const standup = await session.upsertNode({
    type: "Note",
    properties: {
      title: "Standup",
      body: "## Yesterday\n\n- shipped the WebRTC handshake\n",
    },
  });
  await session.upsertEdge({ type: "AUTHORED", from: ada, to: standup });

  // Deliberately never says "hiring": asking for it is how you see semantic
  // search do something full text cannot.
  const headcount = await session.upsertNode({
    type: "Note",
    properties: {
      title: "Q3 headcount",
      body: "## Open roles\n\n- one backend engineer\n- interview loop stays at four rounds\n",
    },
  });
  await session.upsertEdge({ type: "AUTHORED", from: ada, to: headcount });

  // Seed actionable tasks
  const taskWebrtc = await session.upsertNode({
    type: "Task",
    properties: {
      title: "Ship WebRTC reconnection",
      status: "done",
      priority: "high",
    },
  });
  await session.upsertEdge({ type: "ASSIGNED_TO", from: taskWebrtc, to: ada });

  const taskInterview = await session.upsertNode({
    type: "Task",
    properties: {
      title: "Interview backend candidate",
      status: "doing",
      priority: "high",
    },
  });
  await session.upsertEdge({ type: "ASSIGNED_TO", from: taskInterview, to: ada });
  await session.upsertEdge({ type: "PRODUCES_TASK", from: headcount, to: taskInterview });

  const taskDocs = await session.upsertNode({
    type: "Task",
    properties: {
      title: "Update MCP documentation",
      status: "todo",
      priority: "medium",
    },
  });
  await session.upsertEdge({ type: "ASSIGNED_TO", from: taskDocs, to: ada });
}

import { InMemoryGraphStore } from "@collabnode/graph";
import { CollabSession } from "@collabnode/runtime";
import { openWebCollab } from "./backend.js";
import type { ConnectOptions } from "./options.js";
import { resolveWebSchema } from "./schema.js";

export interface WebCollab {
  readonly session: CollabSession;
  readonly schema: CollabSession["schema"];
  readonly documentId: string;
  close(): Promise<void>;
}

export async function connect(options: ConnectOptions): Promise<WebCollab> {
  if (!options.documentId) {
    throw new Error(
      "@collabnode/web connect() requires documentId from the server (webJoinInfo). Browsers join rooms; they do not create them.",
    );
  }
  const schema = resolveWebSchema(options.schema);
  const backend = await openWebCollab(options.collab);
  const store =
    options.graph?.kind === "custom" ? options.graph.store : new InMemoryGraphStore();
  const session = await CollabSession.open(options.documentId, {
    schema,
    collab: backend,
    graph: store,
    actorId: options.actorId,
  });
  return {
    session,
    schema: session.schema,
    documentId: session.id,
    close: () => session.close(),
  };
}

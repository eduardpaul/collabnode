import { createGraphMcpHandler, createGraphMcpServer, serveMcpHttp } from "@collabnode/mcp";
import { CollabSession } from "@collabnode/runtime";
import type { GraphSchema } from "@collabnode/schema";
import { loadSchemaFile } from "@collabnode/schema/node";
import {
  graphKindLabel,
  openCollab,
  openEmbeddings,
  openGraph,
  type CollabJoin,
} from "./backends.js";
import { resolveOptions, type InitOptions } from "./options.js";

export interface Collabnode {
  readonly session: CollabSession;
  readonly schema: GraphSchema;
  readonly documentId: string;
  /** How this process connected; used by `webJoinInfo` for browser peers. */
  readonly collab: CollabJoin;
  handleMcp?(request: Request): Promise<Response>;
  close(): Promise<void>;
}

async function resolveSchema(schema: GraphSchema | string): Promise<GraphSchema> {
  return typeof schema === "string" ? loadSchemaFile(schema) : schema;
}

export async function init(options: InitOptions): Promise<Collabnode> {
  const resolved = resolveOptions(options);
  const schema = await resolveSchema(resolved.schema);
  const store = openGraph(resolved.graph, openEmbeddings(resolved.embeddings));
  const { backend, join, close: closeCollab } = await openCollab(resolved.collab, resolved.actorId);
  const sessionOptions = {
    schema,
    collab: backend,
    graph: store,
    actorId: resolved.actorId,
  };
  // `open` is create-or-join: an absent documentId asks the backend to mint one.
  const session = await CollabSession.open(resolved.documentId, sessionOptions);

  let handleMcp: Collabnode["handleMcp"];
  let closeMcp: (() => Promise<void>) | undefined;
  const mcp = resolved.mcp;

  if (mcp !== false) {
    const mcpLanguage = typeof mcp === "object" ? mcp.language : undefined;
    const handler = createGraphMcpHandler(session, {
      graphKind: graphKindLabel(resolved.graph),
      language: mcpLanguage,
    });
    handleMcp = (request) => handler.fetch(request);
    closeMcp = () => handler.close();
    if (typeof mcp === "object" && mcp.listen) {
      const http = await serveMcpHttp(
        createGraphMcpServer(session, {
          graphKind: graphKindLabel(resolved.graph),
          language: mcpLanguage,
        }),
        mcp.listen,
      );
      const inner = closeMcp;
      closeMcp = async () => {
        await http.close();
        await inner();
      };
    }
  }

  return {
    session,
    schema: session.schema,
    documentId: session.id,
    collab: join,
    handleMcp,
    close: async () => {
      await closeMcp?.();
      await session.close();
      await closeCollab();
    },
  };
}

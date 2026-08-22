import { init, type Collabnode, type InitOptions } from "collabnode";
import type { CliArgs } from "./args.js";

export function initOptionsFromArgs(args: CliArgs, mcp: InitOptions["mcp"]): InitOptions {
  if (!args.schemaPath) {
    throw new Error("a schema yaml path is required");
  }
  if (args.backend === "loro") {
    throw new Error(
      "Loro is not implemented yet. Pass collab: { kind: \"custom\", backend } from the collabnode library, or wait for @collabnode/loro.",
    );
  }
  return {
    schema: args.schemaPath,
    actorId: args.actor,
    documentId: args.join,
    collab:
      args.backend === "memory"
        ? { kind: "memory" }
        : args.backend === "hocuspocus"
          ? { kind: "hocuspocus", port: args.port }
          : { kind: "fluid", relay: args.relay, port: args.port },
    graph:
      args.graph === "ladybug"
        ? { kind: "ladybug", path: args.data ?? "collabnode.lbdb" }
        : args.graph === "age"
          ? { kind: "age", url: args.data, graphName: args.graphName }
          : { kind: "memory" },
    mcp,
  };
}

export async function openFromCli(args: CliArgs, mcp: InitOptions["mcp"] = false): Promise<Collabnode> {
  return init(initOptionsFromArgs(args, mcp));
}

import { init, type Collabnode, type InitOptions } from "collabnode";
import type { CliArgs } from "./args.js";

function collabFromArgs(args: CliArgs): NonNullable<InitOptions["collab"]> {
  switch (args.backend) {
    case "memory":
      return { kind: "memory" };
    case "hocuspocus":
      return { kind: "hocuspocus", port: args.port };
    case "loro":
      return { kind: "loro", ...(args.docs ? { dir: args.docs } : {}) };
    default:
      return { kind: "fluid", relay: args.relay, port: args.port };
  }
}

export function initOptionsFromArgs(args: CliArgs, mcp: InitOptions["mcp"]): InitOptions {
  if (!args.schemaPath) {
    throw new Error("a schema yaml path is required");
  }
  return {
    schema: args.schemaPath,
    actorId: args.actor,
    documentId: args.join,
    collab: collabFromArgs(args),
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

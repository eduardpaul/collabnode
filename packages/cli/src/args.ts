export interface CliArgs {
  command: "validate" | "ddl" | "serve" | "mcp" | "help";
  schemaPath?: string;
  graph: "memory" | "ladybug" | "age";
  data?: string;
  graphName?: string;
  backend: "memory" | "fluid" | "hocuspocus" | "loro";
  relay: "tinylicious" | "azure";
  actor?: string;
  join?: string;
  port: number;
  transport: "stdio" | "http";
  listen: string;
  language?: string;
}

const COMMANDS: CliArgs["command"][] = ["validate", "ddl", "serve", "mcp", "help"];

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const command = (args[0] ?? "help") as CliArgs["command"];
  const rest = args.slice(1);
  const out: CliArgs = {
    command: COMMANDS.includes(command) ? command : "help",
    graph: "memory",
    backend: "fluid",
    relay: "tinylicious",
    port: 7070,
    transport: "stdio",
    listen: "127.0.0.1:3937",
  };
  let portSet = false;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token === "--graph") {
      out.graph = rest[++i] as CliArgs["graph"];
    } else if (token === "--data") {
      out.data = rest[++i];
    } else if (token === "--graph-name") {
      out.graphName = rest[++i];
    } else if (token === "--backend") {
      out.backend = rest[++i] as CliArgs["backend"];
    } else if (token === "--relay") {
      out.relay = rest[++i] as CliArgs["relay"];
    } else if (token === "--actor") {
      out.actor = rest[++i];
    } else if (token === "--join") {
      out.join = rest[++i];
    } else if (token === "--port") {
      out.port = Number(rest[++i]);
      portSet = true;
    } else if (token === "--transport") {
      out.transport = rest[++i] as CliArgs["transport"];
    } else if (token === "--listen") {
      out.listen = rest[++i] ?? out.listen;
    } else if (token === "--language" || token === "-l") {
      out.language = rest[++i];
    } else if (token.startsWith("-")) {
      throw new Error(`unknown flag ${token}`);
    } else {
      positional.push(token);
    }
  }
  out.schemaPath = positional[0];
  if (!portSet && out.backend === "hocuspocus") {
    out.port = 1234;
  }
  return out;
}

export const USAGE = `collabnode <command> [schema.yaml] [flags]

Commands:
  validate <schema.yaml>   Parse and print the graph schema + hash
  ddl <schema.yaml>        Print Ladybug or Apache AGE DDL for the schema
  serve <schema.yaml>      Start a collaborative REPL session
  mcp <schema.yaml>        Start a schema-driven MCP server (agent peer)

Flags:
  --backend memory|fluid|hocuspocus
                           Collab CRDT backend (default fluid). loro is reserved.
  --relay tinylicious|azure
                           Fluid transport (default tinylicious). Azure is hosted;
                           this CLI never starts Fluid Relay.
  --graph memory|ladybug|age
                           Query projection (default memory)
  --data <path|url>        Ladybug database path, or AGE postgres URL
  --graph-name <name>      Apache AGE graph name
  --join <id>              Join an existing collab document
  --actor <id>             Actor id for opt-in change tracking
  --port <n>               Fluid Tinylicious port (default 7070) or
                           Hocuspocus port (default 1234)
  --transport stdio|http   MCP transport (default stdio)
  --listen host:port       MCP HTTP bind (default 127.0.0.1:3937)
  --language <lang>        MCP language (default en, supports es)
`;

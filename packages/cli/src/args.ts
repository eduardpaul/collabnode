export interface CliArgs {
  command: "validate" | "ddl" | "types" | "serve" | "mcp" | "help";
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
  /** `types`: where to write the generated module. Omit for stdout. */
  out?: string;
  /** `types`: base identifier for the emitted const and type. */
  typeName?: string;
  /** `types`: emit the whole workspace, not just what the types read. */
  full?: boolean;
  /** `types`: fail instead of writing when the file on disk is out of date. */
  check?: boolean;
  /** `types`: regenerate whenever the schema file changes. */
  watch?: boolean;
  /** `types`: module specifier the generated file imports library types from. */
  importFrom?: string;
  /** `--backend loro`: directory documents are stored in. Omit to keep them in memory. */
  docs?: string;
}

const COMMANDS: CliArgs["command"][] = ["validate", "ddl", "types", "serve", "mcp", "help"];

/** Flags that take the next token as their value. */
const VALUE_FLAGS: Record<string, (out: CliArgs, value: string | undefined) => void> = {
  "--graph": (out, v) => {
    out.graph = v as CliArgs["graph"];
  },
  "--data": (out, v) => {
    out.data = v;
  },
  "--graph-name": (out, v) => {
    out.graphName = v;
  },
  "--docs": (out, v) => {
    out.docs = v;
  },
  "--backend": (out, v) => {
    out.backend = v as CliArgs["backend"];
  },
  "--relay": (out, v) => {
    out.relay = v as CliArgs["relay"];
  },
  "--actor": (out, v) => {
    out.actor = v;
  },
  "--join": (out, v) => {
    out.join = v;
  },
  "--transport": (out, v) => {
    out.transport = v as CliArgs["transport"];
  },
  "--listen": (out, v) => {
    out.listen = v ?? out.listen;
  },
  "--language": (out, v) => {
    out.language = v;
  },
  "-l": (out, v) => {
    out.language = v;
  },
  "--out": (out, v) => {
    out.out = v;
  },
  "-o": (out, v) => {
    out.out = v;
  },
  "--name": (out, v) => {
    out.typeName = v;
  },
  "--import-from": (out, v) => {
    out.importFrom = v;
  },
};

/** Flags that are on or off. */
const BOOLEAN_FLAGS: Record<string, (out: CliArgs) => void> = {
  "--full": (out) => {
    out.full = true;
  },
  "--check": (out) => {
    out.check = true;
  },
  "--watch": (out) => {
    out.watch = true;
  },
  "-w": (out) => {
    out.watch = true;
  },
};

/**
 * A flag table lookup that cannot reach the prototype.
 *
 * `--foo` is never a prototype key, but a positional argument named
 * `constructor` or `__proto__` is, and a plain index would mistake it for a
 * flag and call whatever it found.
 */
function flag<T>(table: Record<string, T>, token: string): T | undefined {
  return Object.hasOwn(table, token) ? table[token] : undefined;
}

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
    const takesValue = flag(VALUE_FLAGS, token);
    if (takesValue) {
      takesValue(out, rest[++i]);
      continue;
    }
    const boolean = flag(BOOLEAN_FLAGS, token);
    if (boolean) {
      boolean(out);
      continue;
    }
    // `--port` is the one flag with a side effect beyond its own field: whether
    // it was given at all decides the Hocuspocus default below.
    if (token === "--port") {
      out.port = Number(rest[++i]);
      portSet = true;
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
  types <workspace.yaml>   Generate TypeScript types for one workspace
  serve <schema.yaml>      Start a collaborative REPL session
  mcp <schema.yaml>        Start a schema-driven MCP server (agent peer)

Flags:
  --backend memory|fluid|hocuspocus|loro
                           Collab CRDT backend (default fluid). loro is in-process
                           and versioned: history, diffs, and checkout.
  --relay tinylicious|azure
                           Fluid transport (default tinylicious). Azure is hosted;
                           this CLI never starts Fluid Relay.
  --graph memory|ladybug|age
                           Query projection (default memory)
  --data <path|url>        Ladybug database path, or AGE postgres URL
  --docs <dir>             --backend loro: where documents are stored
  --graph-name <name>      Apache AGE graph name
  --join <id>              Join an existing collab document
  --actor <id>             Actor id for opt-in change tracking
  --port <n>               Fluid Tinylicious port (default 7070) or
                           Hocuspocus port (default 1234)
  --transport stdio|http   MCP transport (default stdio)
  --listen host:port       MCP HTTP bind (default 127.0.0.1:3937)
  --language <lang>        MCP language (default en, supports es)

types flags:
  --out, -o <file.ts>      Write here instead of stdout
  --name <Ident>           Base name for the emitted const and type
  --import-from <spec>     Where the module imports library types from
                           (default collabnode)
  --full                   Emit the whole workspace, usable at runtime, not
                           just the fields the types are derived from
  --check                  Exit non-zero if --out is missing or stale, and
                           write nothing. For CI.
  --watch, -w              Regenerate whenever the schema file changes
`;

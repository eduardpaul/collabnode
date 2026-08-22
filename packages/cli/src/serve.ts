import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { CollabSession } from "collabnode";
import type { CliArgs } from "./args.js";
import { openFromCli } from "./session.js";

export async function serve(args: CliArgs): Promise<void> {
  const node = await openFromCli(args, false);
  const session = node.session;

  console.log(`collabnode session`);
  console.log(`  schema     ${session.schema.name} (${session.schema.config.schemaId})`);
  console.log(`  hash       ${session.schema.schemaHash}`);
  console.log(`  backend    ${session.backendKind}`);
  console.log(`  document   ${session.id}`);
  console.log(`  tracking   ${session.schema.config.changeTracking.enabled ? "last-write" : "off"}`);
  console.log(
    `Peers join with: collabnode serve ${args.schemaPath} --join ${session.id} --backend ${args.backend}`,
  );
  console.log(`REPL: node <Type> key=value ... | edge <Type> from=<id> to=<id> | query <cypher> | snapshot | quit`);

  const rl = createInterface({ input, output });
  const shutdown = async () => {
    rl.close();
    await node.close();
  };
  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });

  while (true) {
    const line = (await rl.question("> ")).trim();
    if (!line) {
      continue;
    }
    if (line === "quit" || line === "exit") {
      await shutdown();
      return;
    }
    try {
      await handleLine(session, line);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
  }
}

async function handleLine(session: CollabSession, line: string): Promise<void> {
  const [cmd, ...rest] = line.split(/\s+/);
  if (cmd === "snapshot") {
    console.log(JSON.stringify(session.snapshot(), null, 2));
    return;
  }
  if (cmd === "query") {
    const cypher = rest.join(" ");
    const result = await session.query(cypher);
    console.log(JSON.stringify(result.rows, null, 2));
    return;
  }
  if (cmd === "node") {
    const type = rest[0];
    if (!type) {
      throw new Error("usage: node <Type> key=value ...");
    }
    const properties: Record<string, unknown> = {};
    for (const pair of rest.slice(1)) {
      const eq = pair.indexOf("=");
      if (eq < 1) {
        continue;
      }
      properties[pair.slice(0, eq)] = parseValue(pair.slice(eq + 1));
    }
    const id = await session.upsertNode({ type, properties });
    console.log(id);
    return;
  }
  if (cmd === "edge") {
    const type = rest[0];
    const map: Record<string, string> = {};
    for (const pair of rest.slice(1)) {
      const eq = pair.indexOf("=");
      if (eq < 1) {
        continue;
      }
      map[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    if (!type || !map.from || !map.to) {
      throw new Error("usage: edge <Type> from=<id> to=<id>");
    }
    const { from, to, ...properties } = map;
    const id = await session.upsertEdge({ type, from, to, properties });
    console.log(id);
    return;
  }
  console.log("unknown command");
}

function parseValue(raw: string): unknown {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null") {
    return null;
  }
  const asNum = Number(raw);
  if (raw !== "" && Number.isFinite(asNum) && String(asNum) === raw) {
    return asNum;
  }
  return raw;
}

import { createGraphMcpServer, serveMcpStdio } from "collabnode";
import type { CliArgs } from "./args.js";
import { openFromCli } from "./session.js";

export async function mcp(args: CliArgs): Promise<void> {
  const log = (line: string) => {
    process.stderr.write(`${line}\n`);
  };

  const listen = args.transport === "http" ? args.listen : undefined;
  const node = await openFromCli(
    args,
    listen ? { listen, language: args.language } : false,
  );

  log(`collabnode mcp`);
  log(`  schema     ${node.schema.name} (${node.schema.config.schemaId})`);
  log(`  hash       ${node.schema.schemaHash}`);
  log(`  backend    ${node.session.backendKind}`);
  log(`  document   ${node.documentId}`);
  log(`  actor      ${node.session.actorId ?? "(none)"}`);
  log(`  transport  ${args.transport}`);
  if (args.language) {
    log(`  language   ${args.language}`);
  }
  log(`Peers: collabnode mcp ${args.schemaPath} --join ${node.documentId} --backend ${args.backend} --actor <id>`);

  process.on("SIGINT", () => {
    void node.close().then(() => process.exit(0));
  });

  if (args.transport === "http") {
    log(`  url        http://${args.listen}/mcp`);
    return;
  }

  serveMcpStdio(() =>
    createGraphMcpServer(node.session, {
      graphKind: args.graph,
      language: args.language,
    }),
  );
}

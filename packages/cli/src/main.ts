#!/usr/bin/env node
import { loadSchemaFile, schemaToAgeDdl, schemaToDdl } from "collabnode";
import { parseArgs, USAGE } from "./args.js";
import { mcp } from "./mcp.js";
import { serve } from "./serve.js";
import { types } from "./types.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.command === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (!args.schemaPath) {
    process.stderr.write(USAGE);
    throw new Error(`${args.command} requires a schema yaml path`);
  }
  if (args.command === "validate") {
    const schema = await loadSchemaFile(args.schemaPath);
    console.log(
      JSON.stringify(
        {
          name: schema.name,
          version: schema.version,
          schemaId: schema.config.schemaId,
          schemaHash: schema.schemaHash,
          changeTracking: schema.config.changeTracking,
          tags: schema.config.tags,
          nodes: Object.keys(schema.nodes),
          edges: Object.keys(schema.edges),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (args.command === "ddl") {
    const schema = await loadSchemaFile(args.schemaPath);
    const lines =
      args.graph === "age"
        ? schemaToAgeDdl(schema, args.graphName)
        : schemaToDdl(schema);
    for (const line of lines) {
      console.log(`${line};`);
    }
    return;
  }
  if (args.command === "types") {
    await types(args);
    return;
  }
  if (args.command === "serve") {
    await serve(args);
    return;
  }
  if (args.command === "mcp") {
    await mcp(args);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

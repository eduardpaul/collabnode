#!/usr/bin/env node
import { HelpError, parseArgs, USAGE } from "./args.js";
import { printReport, rowFailed } from "./report.js";
import { runBench } from "./run.js";
import type { BenchOptions } from "./types.js";

async function main(): Promise<void> {
  let options: BenchOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpError) {
      process.stdout.write(USAGE);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const rows = await runBench(options);
  printReport(rows, options.json);
  if (rows.some(rowFailed)) {
    process.exitCode = 1;
  }
}

await main();

import { loadWorkspaceTypeFile, workspaceToTypescript } from "collabnode";
import { readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { CliArgs } from "./args.js";

/**
 * `collabnode types` — the workspace schema as a TypeScript module.
 *
 * The generated file is checked in, so the editor sees it without a build step
 * and CI can prove it matches the YAML. `--watch` is what a dev loop uses;
 * `--check` is what CI uses; neither is required to get a correct file, because
 * the schema hash in the header says which schema it came from.
 */
export async function types(args: CliArgs): Promise<void> {
  const schemaPath = resolve(args.schemaPath!);

  const render = async (): Promise<string> => {
    const workspace = await loadWorkspaceTypeFile(schemaPath);
    return workspaceToTypescript(workspace, {
      name: args.typeName,
      importFrom: args.importFrom,
      full: args.full,
      // Relative to the generated file, not to the shell's cwd: the header has
      // to read the same whoever regenerates it, or `--check` reports drift
      // just because CI ran the command from a different directory.
      source: args.out ? relative(dirname(resolve(args.out)), schemaPath) : basename(schemaPath),
      language: args.language,
    });
  };

  if (args.check) {
    await check(await render(), args.out);
    return;
  }

  await emit(await render(), args.out);

  if (!args.watch) {
    return;
  }
  if (!args.out) {
    throw new Error("--watch needs --out: there is nothing to keep up to date on stdout");
  }
  process.stderr.write(`watching ${relative(process.cwd(), schemaPath)}\n`);
  await watchFile(schemaPath, async () => {
    try {
      await emit(await render(), args.out);
      process.stderr.write(`regenerated ${args.out}\n`);
    } catch (error: unknown) {
      // A schema saved mid-edit is routinely invalid. Report it and keep
      // watching: the next save is usually the fix.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
}

async function emit(source: string, out: string | undefined): Promise<void> {
  if (!out) {
    process.stdout.write(source);
    return;
  }
  if (await unchanged(out, source)) {
    return;
  }
  await writeFile(out, source, "utf8");
}

async function check(source: string, out: string | undefined): Promise<void> {
  if (!out) {
    throw new Error("--check needs --out: it compares against a file on disk");
  }
  const existing = await readFile(out, "utf8").catch(() => undefined);
  if (existing === undefined) {
    throw new Error(`${out} does not exist — run \`collabnode types\` to generate it`);
  }
  if (existing !== source) {
    throw new Error(`${out} is out of date with the schema — regenerate it`);
  }
}

/**
 * Skip a write that would change nothing.
 *
 * Rewriting identical bytes still bumps the mtime, and everything watching the
 * file — the TypeScript server, Vite, a test runner — would rebuild for it.
 */
async function unchanged(out: string, source: string): Promise<boolean> {
  const existing = await readFile(out, "utf8").catch(() => undefined);
  return existing === source;
}

/**
 * Editors save by writing a temporary file and renaming it over the original,
 * which fires several events and can briefly leave nothing at the path at all.
 * Coalescing on a short timer turns that back into one regeneration.
 */
function watchFile(path: string, onChange: () => Promise<void>): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(path, () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void onChange();
      }, 50);
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

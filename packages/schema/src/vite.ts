import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { loadWorkspaceTypeFile } from "./node.js";
import { workspaceToTypescript, type EmitTypescriptOptions } from "./emit-ts.js";

/**
 * Keeps a workspace's generated types current while the dev server runs.
 *
 * The point is that nobody runs a CLI. Save the YAML and the `.ts` beside it is
 * rewritten; the editor's TypeScript server picks the file up from disk on its
 * own, so completions and errors update with no reload and no command.
 *
 * Vite is not imported here — only the two hook shapes below are used, so a
 * package that never runs a bundler does not gain a dependency on one.
 */

export interface CollabnodeTypesOptions extends EmitTypescriptOptions {
  /** The workspace YAML to read. */
  input: string;
  /** The `.ts` module to write. */
  output: string;
}

interface WatchServer {
  watcher: { add(path: string): void; on(event: "change", fn: (path: string) => void): void };
}

export interface CollabnodeTypesPlugin {
  name: string;
  buildStart(): Promise<void>;
  configureServer(server: WatchServer): void;
}

export function collabnodeTypes(options: CollabnodeTypesOptions): CollabnodeTypesPlugin {
  const input = resolve(options.input);
  const output = resolve(options.output);

  const generate = async (): Promise<void> => {
    const workspace = await loadWorkspaceTypeFile(input);
    const source = workspaceToTypescript(workspace, {
      // Same path the CLI writes — relative to the generated file — so a save
      // here and a `collabnode types` run produce byte-identical output.
      source: relative(dirname(output), input),
      ...options,
    });
    // Rewriting identical bytes still bumps the mtime, and everything watching
    // this file would rebuild for it — including the dev server that just
    // triggered us.
    const existing = await readFile(output, "utf8").catch(() => undefined);
    if (existing !== source) {
      await writeFile(output, source, "utf8");
    }
  };

  return {
    name: "collabnode-types",
    async buildStart() {
      await generate();
    },
    configureServer(server) {
      server.watcher.add(input);
      server.watcher.on("change", (path) => {
        if (resolve(path) !== input) {
          return;
        }
        // A schema saved mid-edit is routinely invalid. Report and keep
        // watching — the next save is usually the fix, and taking the dev
        // server down over a half-typed enum would be worse than a warning.
        void generate().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[collabnode-types] ${message}`);
        });
      });
    },
  };
}

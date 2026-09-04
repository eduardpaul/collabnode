import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoroDocStore } from "./backend.js";

/**
 * Documents as files in a directory, one file per workspace.
 *
 * Enough to make a single-host hub survive a restart, and small enough to read
 * in one sitting — which is the point: Loro has no storage of its own, so the
 * question "where do my documents live" has to be answered by the application,
 * and this is the answer for the case where the application does not care.
 * Anything larger — many hosts, object storage, a row beside the workspace
 * registry — implements `LoroDocStore` the same way.
 */
export function fileDocStore(directory: string): LoroDocStore {
  const pathFor = (id: string): string => join(directory, `${encodeURIComponent(id)}.loro`);
  return {
    async load(id) {
      try {
        const bytes = await readFile(pathFor(id));
        return new Uint8Array(bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async save(id, bytes) {
      const path = pathFor(id);
      await mkdir(dirname(path), { recursive: true });
      // Write beside and rename: a crash mid-write would otherwise leave a
      // truncated file, and a truncated Loro document fails its checksum on
      // import rather than loading partially — the workspace would be gone.
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, bytes);
      const { rename } = await import("node:fs/promises");
      await rename(temporary, path);
    },
    async delete(id) {
      await rm(pathFor(id), { force: true });
    },
    async exists(id) {
      try {
        await stat(pathFor(id));
        return true;
      } catch {
        return false;
      }
    },
  };
}

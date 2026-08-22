import { createConnection } from "node:net";
import { Server } from "@hocuspocus/server";
import { DEFAULT_HOCUSPOCUS_PORT } from "./url.js";

export async function waitForPort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 15_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (open) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Start an in-process Hocuspocus server if nothing is listening on `port`.
 * Returns the server when this process owns it; undefined when the port was
 * already open (another init() or an external Hocuspocus).
 */
export async function ensureHocuspocus(
  port: number = DEFAULT_HOCUSPOCUS_PORT,
): Promise<Server | undefined> {
  if (await waitForPort(port, "127.0.0.1", 300)) {
    return undefined;
  }
  const server = new Server({
    port,
    address: "127.0.0.1",
    quiet: true,
    stopOnSignals: false,
  });
  await server.listen();
  const ready = await waitForPort(port);
  if (!ready) {
    await stopHocuspocus(server);
    throw new Error(
      `Could not start Hocuspocus on port ${port}. Pass collab.url after starting a server yourself, or free the port.`,
    );
  }
  return server;
}

export async function stopHocuspocus(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  const port = server.configuration.port ?? DEFAULT_HOCUSPOCUS_PORT;
  await Promise.race([
    server.destroy(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2_000);
    }),
  ]);
  const http = server.httpServer as typeof server.httpServer & {
    closeAllConnections?: () => void;
  };
  try {
    http.closeAllConnections?.();
  } catch {
    // Server already torn down.
  }
  await new Promise<void>((resolve) => {
    http.close(() => resolve());
    setTimeout(resolve, 500);
  });
  const start = Date.now();
  while (Date.now() - start < 2_000) {
    if (!(await waitForPort(port, "127.0.0.1", 50))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Purge a document from a Hocuspocus server this process owns: unload it from
 * memory and close any connection still holding it.
 *
 * `HocuspocusCollabBackend.delete` empties the document from the client side,
 * which is what removes the *content*. This removes the record, and is the
 * server-side half an ephemeral deployment needs — a persistence extension
 * that stores by document name should also delete its own row here, which is
 * why `onPurge` is passed the name rather than assumed.
 */
export async function deleteHocuspocusDocument(
  server: Server | undefined,
  name: string,
  onPurge?: (name: string) => Promise<void> | void,
): Promise<boolean> {
  const hocuspocus = server?.hocuspocus;
  if (!hocuspocus) {
    return false;
  }
  const document = hocuspocus.documents.get(name);
  if (document) {
    hocuspocus.closeConnections(name);
    await hocuspocus.unloadDocument(document);
  }
  await onPurge?.(name);
  return document !== undefined;
}

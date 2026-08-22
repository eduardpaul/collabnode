import { CollabError } from "@collabnode/collab";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { DEFAULT_HOCUSPOCUS_PORT, hocuspocusUrl } from "./url.js";

export interface OpenProviderOptions {
  url?: string;
  name: string;
  document?: Y.Doc;
}

export function openProvider(options: OpenProviderOptions): {
  provider: HocuspocusProvider;
  document: Y.Doc;
} {
  const document = options.document ?? new Y.Doc();
  const provider = new HocuspocusProvider({
    url: options.url ?? hocuspocusUrl(DEFAULT_HOCUSPOCUS_PORT),
    name: options.name,
    document,
  });
  return { provider, document };
}

export async function waitUntilSynced(
  provider: HocuspocusProvider,
  timeoutMs = 10_000,
): Promise<void> {
  if (provider.synced) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const done = (data?: { state?: boolean }): void => {
      if (data && data.state === false) {
        return;
      }
      clearTimeout(timer);
      provider.off("synced", done);
      provider.off("authenticationFailed", fail);
      resolve();
    };
    const fail = (data: { reason: string }): void => {
      clearTimeout(timer);
      provider.off("synced", done);
      provider.off("authenticationFailed", fail);
      reject(new CollabError(`Hocuspocus auth failed: ${data.reason}`));
    };
    const timer = setTimeout(() => {
      provider.off("synced", done);
      provider.off("authenticationFailed", fail);
      reject(
        new CollabError(
          `Hocuspocus document '${provider.configuration.name}' did not sync within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    provider.on("synced", done);
    provider.on("authenticationFailed", fail);
    if (provider.synced) {
      done({ state: true });
    }
  });
}

export async function waitUntilFlushed(
  provider: HocuspocusProvider,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (provider.hasUnsyncedChanges && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function destroyProvider(provider: HocuspocusProvider): Promise<void> {
  provider.configuration.websocketProvider.disconnect();
  provider.destroy();
}

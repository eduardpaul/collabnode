import type { CollabBackend } from "@collabnode/collab";
import type { IFluidContainer } from "fluid-framework";
import type { AzureTokenProvider, WebCollabKind } from "./options.js";
import { httpTokenProvider } from "./token.js";

export async function openWebCollab(
  collab: WebCollabKind,
  options: { actorId?: string } = {},
): Promise<CollabBackend> {
  if (collab.kind === "custom") {
    return collab.backend;
  }
  if (collab.kind === "hocuspocus") {
    return openHocuspocus(collab);
  }
  if (collab.kind === "fluid" && collab.relay === "azure") {
    return openAzureFluid(collab, options.actorId);
  }
  return openTinyliciousFluid(collab);
}

/**
 * The provider this descriptor asks for. A `tokenEndpoint` becomes an
 * `httpTokenProvider` here rather than in every app: a join payload can only
 * ever carry the URL, so turning it into a provider was work every browser was
 * repeating before it could call `connect()`.
 */
function azureTokenProvider(
  collab: Extract<WebCollabKind, { relay: "azure" }>,
  actorId: string | undefined,
): AzureTokenProvider {
  if (collab.tokenProvider) {
    return collab.tokenProvider;
  }
  if (!collab.tokenEndpoint) {
    throw new Error(
      "Azure Fluid Relay needs a tokenEndpoint or a tokenProvider: the relay rejects unsigned tokens, and the tenant key must never reach a browser. Mount a route with createFluidTokenHandler and name it in the join payload.",
    );
  }
  return httpTokenProvider(collab.tokenEndpoint, {
    ...(actorId !== undefined ? { actorId } : {}),
  });
}

async function loadHocuspocus(): Promise<typeof import("@collabnode/hocuspocus")> {
  try {
    return await import("@collabnode/hocuspocus");
  } catch (error) {
    throw new Error(
      `Install @collabnode/hocuspocus to use collab.kind "hocuspocus". ${String(error)}`,
    );
  }
}

async function openHocuspocus(
  collab: Extract<WebCollabKind, { kind: "hocuspocus" }>,
): Promise<CollabBackend> {
  const { HocuspocusCollabBackend } = await loadHocuspocus();
  return new HocuspocusCollabBackend({ url: collab.url });
}

async function loadFluid(): Promise<typeof import("@collabnode/fluid")> {
  try {
    return await import("@collabnode/fluid");
  } catch (error) {
    throw new Error(
      `Install @collabnode/fluid to use collab.kind "fluid". ${String(error)}`,
    );
  }
}

async function openTinyliciousFluid(collab: WebCollabKind): Promise<CollabBackend> {
  const { FluidCollabBackend } = await loadFluid();
  const domain = collab.kind === "fluid" && "domain" in collab ? collab.domain : undefined;
  const port = collab.kind === "fluid" && "port" in collab ? collab.port : undefined;
  return new FluidCollabBackend({ domain, port });
}

async function openAzureFluid(
  collab: Extract<WebCollabKind, { relay: "azure" }>,
  actorId: string | undefined,
): Promise<CollabBackend> {
  const { FluidCollabBackend, fluidContainerSchema } = await loadFluid();
  const client = await createAzureClient(collab, azureTokenProvider(collab, actorId));
  return new FluidCollabBackend({
    open: {
      create: async () => {
        throw new Error(
          "@collabnode/web connect() joins an existing document; create rooms with collabnode init() on the server",
        );
      },
      load: async (id) => {
        const { container } = await client.getContainer(id, fluidContainerSchema, "2");
        return container;
      },
    },
  });
}

interface AzureClientLike {
  getContainer(
    id: string,
    schema: unknown,
    version: string,
  ): Promise<{ container: IFluidContainer }>;
}

async function createAzureClient(
  collab: Extract<WebCollabKind, { relay: "azure" }>,
  tokenProvider: AzureTokenProvider,
): Promise<AzureClientLike> {
  try {
    const mod = (await import("@fluidframework/azure-client")) as {
      AzureClient: new (opts: unknown) => AzureClientLike;
    };
    return new mod.AzureClient({
      connection: {
        type: "remote",
        tenantId: collab.tenantId,
        endpoint: collab.endpoint,
        tokenProvider,
      },
    });
  } catch (error) {
    throw new Error(
      `Install peer dependency @fluidframework/azure-client to join Azure Fluid Relay from the browser. ${String(error)}`,
    );
  }
}

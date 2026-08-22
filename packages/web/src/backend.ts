import type { CollabBackend } from "@collabnode/collab";
import type { IFluidContainer } from "fluid-framework";
import type { WebCollabKind } from "./options.js";

export async function openWebCollab(collab: WebCollabKind): Promise<CollabBackend> {
  if (collab.kind === "custom") {
    return collab.backend;
  }
  if (collab.kind === "hocuspocus") {
    return openHocuspocus(collab);
  }
  if (collab.kind === "fluid" && collab.relay === "azure") {
    return openAzureFluid(collab);
  }
  return openTinyliciousFluid(collab);
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
): Promise<CollabBackend> {
  const { FluidCollabBackend, fluidContainerSchema } = await loadFluid();
  const client = await createAzureClient(collab);
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
        tokenProvider: collab.tokenProvider,
      },
    });
  } catch (error) {
    throw new Error(
      `Install peer dependency @fluidframework/azure-client to join Azure Fluid Relay from the browser. ${String(error)}`,
    );
  }
}

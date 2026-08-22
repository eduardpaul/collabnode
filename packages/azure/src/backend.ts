import {
  FluidCollabBackend,
  fluidContainerSchema,
  type FluidCollabBackendOptions,
} from "@collabnode/fluid";
import type { IFluidContainer } from "fluid-framework";

export interface AzureTokenResponse {
  jwt: string;
}

export interface AzureTokenProvider {
  fetchOrdererToken(tenantId: string, documentId?: string): Promise<AzureTokenResponse>;
  fetchStorageToken(tenantId: string, documentId?: string): Promise<AzureTokenResponse>;
}

export interface AzureRelayConfig {
  tenantId: string;
  endpoint: string;
  tokenProvider: AzureTokenProvider;
}

interface AzureClientLike {
  createContainer(
    schema: unknown,
    version: string,
  ): Promise<{ container: IFluidContainer }>;
  getContainer(
    id: string,
    schema: unknown,
    version: string,
  ): Promise<{ container: IFluidContainer }>;
}

/**
 * Azure Fluid Relay is a hosted service. This adapter only *connects* to a
 * provisioned tenant; it does not start a relay process.
 */
export function azureOpen(
  config: AzureRelayConfig,
): NonNullable<FluidCollabBackendOptions["open"]> {
  return {
    create: async () => {
      const client = await createClient(config);
      const { container } = await client.createContainer(fluidContainerSchema, "2");
      const id = await container.attach();
      return { container, id };
    },
    load: async (id: string) => {
      const client = await createClient(config);
      const { container } = await client.getContainer(id, fluidContainerSchema, "2");
      return container;
    },
  };
}

export class AzureFluidCollabBackend extends FluidCollabBackend {
  constructor(config: AzureRelayConfig) {
    super({ open: azureOpen(config) });
  }
}

export function azureRelayFromEnv(
  tokenProvider: AzureTokenProvider,
  env: NodeJS.ProcessEnv = process.env,
): AzureRelayConfig {
  const tenantId = env.AZURE_FLUID_TENANT_ID;
  const endpoint = env.AZURE_FLUID_ENDPOINT;
  if (!tenantId || !endpoint) {
    throw new Error(
      "Azure Fluid Relay requires AZURE_FLUID_TENANT_ID and AZURE_FLUID_ENDPOINT (the relay is provisioned in Azure, not started by this CLI)",
    );
  }
  return { tenantId, endpoint, tokenProvider };
}

export function staticKeyTokenProvider(
  key: string,
  user: { id: string; name?: string },
): AzureTokenProvider {
  return {
    async fetchOrdererToken(tenantId: string, documentId?: string) {
      return { jwt: encodeDemoJwt(key, tenantId, documentId, user) };
    },
    async fetchStorageToken(tenantId: string, documentId?: string) {
      return { jwt: encodeDemoJwt(key, tenantId, documentId, user) };
    },
  };
}

function encodeDemoJwt(
  key: string,
  tenantId: string,
  documentId: string | undefined,
  user: { id: string; name?: string },
): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      documentId,
      scopes: ["doc:read", "doc:write", "summary:write"],
      tenantId,
      user,
      ver: "1.0",
      keyHint: key.slice(0, 4),
    }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

async function createClient(config: AzureRelayConfig): Promise<AzureClientLike> {
  const mod = await loadAzureClient();
  return new mod.AzureClient({
    connection: {
      type: "remote",
      tenantId: config.tenantId,
      endpoint: config.endpoint,
      tokenProvider: config.tokenProvider,
    },
  });
}

async function loadAzureClient(): Promise<{
  AzureClient: new (opts: unknown) => AzureClientLike;
}> {
  try {
    return (await import("@fluidframework/azure-client")) as never;
  } catch (error) {
    throw new Error(
      `Install peer dependency @fluidframework/azure-client to use Azure Fluid Relay. ${String(error)}`,
    );
  }
}

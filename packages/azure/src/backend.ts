import {
  FluidCollabBackend,
  fluidContainerSchema,
  type FluidCollabBackendOptions,
} from "@collabnode/fluid";
import type { IFluidContainer } from "fluid-framework";
import {
  signAzureFluidToken,
  type AzureFluidUser,
  type AzureTokenOptions,
} from "./token.js";

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

export interface AzureRelayFromEnvOptions extends AzureTokenOptions {
  /** Identity stamped into tokens minted from `AZURE_FLUID_KEY`. */
  user?: AzureFluidUser;
}

/**
 * Reads `AZURE_FLUID_TENANT_ID` and `AZURE_FLUID_ENDPOINT`.
 *
 * With no `tokenProvider`, it also reads `AZURE_FLUID_KEY` and signs tokens
 * itself — right for a server process, wrong for anything that runs in a
 * browser. Browser peers get their tokens from an HTTP route instead; see
 * `createFluidTokenHandler` in `collabnode`.
 */
export function azureRelayFromEnv(
  tokenProvider?: AzureTokenProvider,
  env: NodeJS.ProcessEnv = process.env,
  options: AzureRelayFromEnvOptions = {},
): AzureRelayConfig {
  const tenantId = env.AZURE_FLUID_TENANT_ID;
  const endpoint = env.AZURE_FLUID_ENDPOINT;
  if (!tenantId || !endpoint) {
    throw new Error(
      "Azure Fluid Relay requires AZURE_FLUID_TENANT_ID and AZURE_FLUID_ENDPOINT (the relay is provisioned in Azure, not started by this CLI)",
    );
  }

  const resolved = tokenProvider ?? providerFromEnv(env, options);
  return { tenantId, endpoint, tokenProvider: resolved };
}

function providerFromEnv(
  env: NodeJS.ProcessEnv,
  options: AzureRelayFromEnvOptions,
): AzureTokenProvider {
  const key = env.AZURE_FLUID_KEY;
  if (!key) {
    throw new Error(
      "Azure Fluid Relay requires AZURE_FLUID_KEY to mint tokens, or an explicit tokenProvider",
    );
  }
  const { user, ...tokenOptions } = options;
  return staticKeyTokenProvider(
    key,
    user ?? { id: env.AZURE_FLUID_USER_ID ?? "collabnode", name: env.AZURE_FLUID_USER_NAME },
    tokenOptions,
  );
}

/**
 * Mints HS256 tokens from the tenant key, on this process, for this user.
 *
 * The key is a bearer credential for the whole tenant: whoever holds it can
 * read and write every document in it. Keep it server-side and hand browsers a
 * per-document token from a route you control.
 */
export function staticKeyTokenProvider(
  key: string,
  user: AzureFluidUser,
  options: AzureTokenOptions = {},
): AzureTokenProvider {
  const mint = async (tenantId: string, documentId?: string): Promise<AzureTokenResponse> => ({
    jwt: signAzureFluidToken({ key, tenantId, documentId, user, ...options }),
  });
  return {
    fetchOrdererToken: mint,
    fetchStorageToken: mint,
  };
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
